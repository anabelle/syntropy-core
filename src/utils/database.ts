/**
 * Database Utilities
 * 
 * Provides database-related utility functions including connection helpers,
 * query builders, and Unicode safety for database operations.
 */

import { sanitizeUnicodeForDB } from '../../pixel-agent/src/utils/validation';

/**
 * Applies Unicode sanitization to database record before insertion.
 * This function ensures that all JSONB content is free of invalid Unicode
 * sequences that would cause PostgreSQL to reject the insertion.
 * 
 * @param record - The database record to sanitize
 * @returns A sanitized version of the record
 */
export const sanitizeRecordForDB = (record: any): any => {
  if (!record || typeof record !== 'object') {
    return record;
  }

  // Sanitize all JSONB-type columns
  const sanitized: any = {};
  
  for (const [key, value] of Object.entries(record)) {
    // Common JSONB column names in ElizaOS schema
    const isJSONBColumn = ['body', 'content', 'metadata', 'extra', 'data'].includes(key);
    
    if (isJSONBColumn && (typeof value === 'string' || typeof value === 'object')) {
      sanitized[key] = sanitizeUnicodeForDB(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
};

/**
 * Wraps a PostgreSQL database adapter method with Unicode sanitization.
 * This can be used to monkey-patch adapter methods at runtime.
 * 
 * @param originalMethod - The original database adapter method
 * @param recordParamIndex - Which parameter index contains the record (default: 0)
 * @returns A wrapped method that sanitizes before insertion
 */
export const wrapWithUnicodeSafety = (
  originalMethod: Function,
  recordParamIndex: number = 0
): Function => {
  return async function(this: any, ...args: any[]) {
    // Sanitize the record parameter if it exists
    if (args[recordParamIndex] && typeof args[recordParamIndex] === 'object') {
      args[recordParamIndex] = sanitizeRecordForDB(args[recordParamIndex]);
    }

    return originalMethod.apply(this, args);
  };
};

/**
 * Applies comprehensive Unicode safety patches to PostgreSQL adapter.
 * This patches all methods that insert JSON data into the database.
 */
export const applyDatabaseUnicodePatches = () => {
  try {
    const adapterModule = require('/app/node_modules/@elizaos/adapter-postgres/dist/index.js');
    const PostgresDatabaseAdapter = adapterModule.PostgresDatabaseAdapter;

    if (!PostgresDatabaseAdapter || !PostgresDatabaseAdapter.prototype) {
      console.warn('[DBUtils] PostgresDatabaseAdapter not found, skipping patch');
      return;
    }

    // Patch createMemory - inserts into memories table
    if (PostgresDatabaseAdapter.prototype.createMemory) {
      const originalCreateMemory = PostgresDatabaseAdapter.prototype.createMemory;
      PostgresDatabaseAdapter.prototype.createMemory = async function(this: any, memory: any, tableName: string) {
        if (memory && memory.content) {
          try {
            const sanitized = sanitizeUnicodeForDB(memory.content);
            if (sanitized !== memory.content) {
              console.log('[DBUtils] createMemory content sanitized');
            }
            memory.content = sanitized;
          } catch (error) {
            console.error('[DBUtils] Error sanitizing memory content:', error);
          }
        }
        return originalCreateMemory.call(this, memory, tableName);
      };
      console.log('[DBUtils] Patched PostgresDatabaseAdapter.createMemory');
    }

    // Patch createLog - inserts into logs table (this is the critical one for current errors)
    if (PostgresDatabaseAdapter.prototype.createLog) {
      const originalCreateLog = PostgresDatabaseAdapter.prototype.createLog;
      PostgresDatabaseAdapter.prototype.createLog = async function(this: any, log: any) {
        if (log && log.body) {
          try {
            const sanitized = sanitizeUnicodeForDB(log.body);
            if (sanitized !== log.body) {
              console.log('[DBUtils] createLog body sanitized');
            }
            log.body = sanitized;
          } catch (error) {
            console.error('[DBUtils] Error sanitizing log body:', error);
          }
        }
        return originalCreateLog.call(this, log);
      };
      console.log('[DBUtils] Patched PostgresDatabaseAdapter.createLog');
    }

    // Patch any other methods that insert JSON data
    const jsonInsertionMethods = ['create', 'insert', 'save', 'update'];
    for (const methodName of jsonInsertionMethods) {
      if (PostgresDatabaseAdapter.prototype[methodName] && 
          !PostgresDatabaseAdapter.prototype[methodName].__unicodePatched) {
        const original = PostgresDatabaseAdapter.prototype[methodName];
        PostgresDatabaseAdapter.prototype[methodName] = wrapWithUnicodeSafety(original, 0);
        PostgresDatabaseAdapter.prototype[methodName].__unicodePatched = true;
        console.log(`[DBUtils] Patched PostgresDatabaseAdapter.${methodName}`);
      }
    }

    console.log('[DBUtils] All database Unicode patches applied successfully');
  } catch (error) {
    console.error('[DBUtils] Failed to apply database Unicode patches:', error);
  }
};
