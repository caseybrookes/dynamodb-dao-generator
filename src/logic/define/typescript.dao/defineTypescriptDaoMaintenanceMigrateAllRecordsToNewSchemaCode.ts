import { camelCase } from 'change-case';
import { DomainObjectMetadata } from 'domain-objects-metadata';

import { getPackageVersion } from '../../../utils/getPackageVersion';
import { getTypescriptTableNameBuilderCode } from './getTypescriptTableNameBuilderCode';

export const defineTypescriptDaoMaintenanceMigrateAllRecordsToNewSchemaCode = ({
  domainObjectMetadata,
}: {
  domainObjectMetadata: DomainObjectMetadata;
}): string => {
  // define the code
  const code = `
import DynamoDB, { Key } from 'aws-sdk/clients/dynamodb';
import Bottleneck from 'bottleneck';
import { simpleDynamodbClient } from 'simple-dynamodb-client';

import { getConfig } from '../../../../utils/config/getConfig';
import { log } from '../../../../utils/logger';
import { castFromDatabaseObject } from '../castFromDatabaseObject';
import { castToDatabaseObject } from '../castToDatabaseObject';
import { findByUnique } from '../findByUnique';
import { upsert } from '../upsert';

const bottleneck = new Bottleneck({ maxConcurrent: 1000 }); // beyond 1000 concurrent operations, failures making the requests occur

/**
 * reads all records from the database and then writes them back to the table, one at a time
 * - makes sure to carefully handle the changing of the hash key of the unique table
 *   - i.e., if your unique key or its serialization method changed, this will update the table's hash key to the new unique key format
 * - makes sure to handle potential situations which would result in a second uuid being generated for the same entity
 *   - i.e., if your unique key table does not have this record, but your uuid table does, then the record does have a uuid already it just was not indexed
 *   - in these cases, we actually write to the unique table directly outside of the upsert function, to rebuild the findByUnique ability
 * - this enables migrating to new schemas which may involve the complete replacement or new creation of secondary indexes or index tables
 *   - since the source table can be customized, you can rebuild cleared tables or migrate to entirely new namespaces all together, easily
 *
 * note
 * - this method is a exclusively developer tool and should not be used as a part of regular transaction processing
 * - this code was generated by the 'dynamodb-dao-generator@${getPackageVersion()}'
 */
export const migrateAllRecordsToNewSchema = async ({
  dryRun,
  sourceTableName: inputSourceTableName,
}: {
  /**
   * show what would have been done without actually doing anything
   */
  dryRun: boolean;

  /**
   * enable specifying a different source table to migrate the data from
   *
   * note
   * - by default, we load the data from the *ByUniqueOnNaturalKey table
   */
  sourceTableName?: string;
}) => {
  // define the tables
  const config = await getConfig();
  const uniqueKeyTableName = ${getTypescriptTableNameBuilderCode({
    domainObjectMetadata,
    keyType: 'UNIQUE',
  })}
  const sourceTableName = inputSourceTableName ?? uniqueKeyTableName; // by default, read from the unique natural key table for this domain object

  // read all records from the table, looping through each page
  const dynamodbClient = new DynamoDB.DocumentClient(); // TODO: support scan operation w/ of simpleDynamodbClient https://github.com/uladkasach/simple-dynamodb-client/issues/4
  const pages: any[][] = [];
  let lastEvaluatedKey: Key | undefined;
  while (true) {
    log.info('migrateAllRecordsToNewSchema.progress: querying for a page', {
      from: sourceTableName,
      lastEvaluatedKey,
      pagesSoFar: pages.length,
      itemsSoFar: pages.flat().length,
    });
    const result = await dynamodbClient
      .scan({
        TableName: sourceTableName,
        ProjectionExpression: 'p,o',
        ExclusiveStartKey: lastEvaluatedKey,
      })
      .promise();
    pages.push(result.Items ?? []);
    if (!result.LastEvaluatedKey) break; // exit the loop once there are no more pages, as identified by the lastEvaluatedKey no longer being defined
    lastEvaluatedKey = result.LastEvaluatedKey;
  }
  const items = pages.flat();
  const objects = items.map(castFromDatabaseObject);
  log.info(
    'migrateAllRecordsToNewSchema.progress: fetched all dynamodb items',
    { result: { pages: pages.length, items: items.length } },
  );

  // write each item who's serialized unique key representation changed; this is to ensure that we'll find the object in the upsert and therefore use the original uuid rather than assign a new one
  const writtenRecords: any[] = [];
  await Promise.all(
    objects.map(async (object, index) =>
      bottleneck.schedule(async () => {
        // lookup the expected and found serialized key
        const item = castToDatabaseObject({
          ${camelCase(domainObjectMetadata.name)}: object,
        });
        const expectedSerializedUniqueKey = item.byUniqueOnNaturalKey.p;
        const foundSerializedUniqueKey = items[index].p;

        // if the expected key is the found key, then there's no special write needed
        if (expectedSerializedUniqueKey === foundSerializedUniqueKey) return;

        // otherwise, check whether a record already exists for the expected key (to avoid accidentally overwriting newer data with older data)
        const alsoFoundByExpectedKey = await findByUnique(object);
        log.debug(
          'migrateAllRecordsToNewSchema.progress: found record with outdated unique key serialization to replace and remove',
          {
            expectedSerializedUniqueKey,
            foundSerializedUniqueKey,
            alsoFoundByExpectedKey: !!alsoFoundByExpectedKey,
          },
        );

        // if its safe to do so, write the found object to the unique key table with the expected key
        if (
          !alsoFoundByExpectedKey || //  if the object doesn't already exist by the expected key, then its safe to do so, since cant overwrite data
          alsoFoundByExpectedKey.updatedAt < object.updatedAt // if the object found by the expected key has an updatedAt timestamp earlier than our current object, then our current object is more up to date, so its safe to do so here too
        ) {
          if (!dryRun)
            await simpleDynamodbClient.put({
              tableName: uniqueKeyTableName,
              logDebug: log.debug,
              item: item.byUniqueOnNaturalKey,
            });
          writtenRecords.push(object);
        }
      }),
    ),
  );
  log.info(
    'migrateAllRecordsToNewSchema.progress: updated unique key table records',
    { uniqueKeyTableName, writtenRecords: writtenRecords.length },
  );

  // write each item back to the database using upsert, which will ensure that its written to all the required indexes
  if (!dryRun)
    await Promise.all(
      objects.map((object) =>
        bottleneck.schedule(async () =>
          upsert({
            ${camelCase(domainObjectMetadata.name)}: object,
            force: true, // note: must use \`force\` since the unique index would have just received the latest data, so it would seem like no writes are needed
          }),
        ),
      ),
    );
  log.info('migrateAllRecordsToNewSchema.progress: force upserted each object', { objects: objects.length })

  // return stats
  const stats = {
    from: sourceTableName,
    to: uniqueKeyTableName,

    /**
     * the row level modifications needed to support the migration
     */
    modified: {
      writtenUniqueKeyRecords: writtenRecords.length,
    },

    /**
     * the overall domain objects that were successfully migrated
     */
    migrated: {
      objects: objects.length,
    },
  };
  log.info('migrateAllRecordsToNewSchema.output', { stats, dryRun });
  return stats;
};

  `;

  // define the code
  return code;
};