/**
 * Cafe Cloud POS — Test Database Safety Guard Unit Tests
 *
 * Verifies that the centralized guard strictly enforces the fail-closed strategy:
 * 1. Dedicated test database names accepted ('cafe_cloud_pos_test' and 'test').
 * 2. Non-test and prohibited database names rejected ('cafe_test_production', 'contest_database', 'cafe_cloud_pos').
 * 3. Missing host rejected (no silent fallback to localhost).
 * 4. Approved local hosts accepted ('localhost', '127.0.0.1', '::1', 'postgres', 'cafe-cloud-postgres', 'db').
 * 5. Remote and cloud hosts rejected (Railway, rlwy.net, AWS RDS, arbitrary IP, external domains).
 * 6. PostgreSQL connection strings validated strictly.
 * 7. Migration runner executes guard before database connection in test mode.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateTestDatabaseSafety,
  assertSafeTestDatabase,
  extractDbIdentity,
  APPROVED_LOCAL_HOSTS,
  PROHIBITED_DATABASE_NAMES
} = require('../src/config/test-db-guard');
const { getClient } = require('../../database/migrate');
const { getSeedClient } = require('../../database/seed');
const { getVerifyClient } = require('../../database/verify');

describe('Test Database Safety Guard Unit Tests (Fail-Closed Corrections)', () => {
  const validTestEnv = { NODE_ENV: 'test' };

  describe('1. Database Name Suffix and Exact Match Validation', () => {
    it('accepts database named exactly "cafe_cloud_pos_test" (ends in _test)', () => {
      const config = {
        host: 'localhost',
        database: 'cafe_cloud_pos_test',
        port: 5432
      };
      const result = validateTestDatabaseSafety(config, validTestEnv);
      assert.strictEqual(result.safe, true);
      assert.strictEqual(result.host, 'localhost');
      assert.strictEqual(result.database, 'cafe_cloud_pos_test');
      assert.strictEqual(result.port, 5432);
    });

    it('accepts database named exactly "test"', () => {
      const config = {
        host: 'localhost',
        database: 'test',
        port: 5432
      };
      const result = validateTestDatabaseSafety(config, validTestEnv);
      assert.strictEqual(result.safe, true);
      assert.strictEqual(result.host, 'localhost');
      assert.strictEqual(result.database, 'test');
    });

    it('rejects "cafe_test_production" (contains "test" but does not end in _test)', () => {
      const config = {
        host: 'localhost',
        database: 'cafe_test_production'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Unsafe database name 'cafe_test_production'/
        }
      );
    });

    it('rejects "contest_database" (contains "test" as substring but does not end in _test)', () => {
      const config = {
        host: 'localhost',
        database: 'contest_database'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Unsafe database name 'contest_database'/
        }
      );
    });

    it('rejects prohibited standard development database name (cafe_cloud_pos)', () => {
      const config = {
        host: 'localhost',
        database: 'cafe_cloud_pos'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Unsafe database name 'cafe_cloud_pos'/
        }
      );
    });

    it('rejects default postgres database', () => {
      const config = {
        host: '127.0.0.1',
        database: 'postgres'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Unsafe database name 'postgres'/
        }
      );
    });

    it('rejects explicit production database name', () => {
      const config = {
        host: 'localhost',
        database: 'production'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Unsafe database name 'production'/
        }
      );
    });
  });

  describe('2. Missing Host Rejection (Fail-Closed, No Silent Fallback to Localhost)', () => {
    it('rejects config object with database but omitted host', () => {
      const config = {
        database: 'cafe_cloud_pos_test'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Database host is not specified/
        }
      );
    });

    it('rejects config with empty string host', () => {
      const config = {
        host: '',
        database: 'cafe_cloud_pos_test'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Database host is not specified/
        }
      );
    });

    it('rejects config with whitespace-only host', () => {
      const config = {
        host: '   ',
        database: 'cafe_cloud_pos_test'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Database host is not specified/
        }
      );
    });

    it('rejects config with null host', () => {
      const config = {
        host: null,
        database: 'cafe_cloud_pos_test'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Database host is not specified/
        }
      );
    });

    it('extractDbIdentity returns empty string for host when not specified in config', () => {
      const identity = extractDbIdentity({ database: 'cafe_cloud_pos_test' }, validTestEnv);
      assert.strictEqual(identity.host, '');
      assert.strictEqual(identity.database, 'cafe_cloud_pos_test');
    });
  });

  describe('3. Approved Local Hosts Accepted', () => {
    const approvedHosts = ['localhost', '127.0.0.1', '::1', 'postgres', 'cafe-cloud-postgres', 'db'];

    for (const host of approvedHosts) {
      it(`accepts approved local host: "${host}"`, () => {
        const config = {
          host,
          database: 'cafe_cloud_pos_test'
        };
        const result = validateTestDatabaseSafety(config, validTestEnv);
        assert.strictEqual(result.safe, true);
        assert.strictEqual(result.host, host);
        assert.strictEqual(result.database, 'cafe_cloud_pos_test');
      });
    }

    it('verifies APPROVED_LOCAL_HOSTS matches exact approved set', () => {
      assert.deepStrictEqual(
        Array.from(APPROVED_LOCAL_HOSTS).sort(),
        ['127.0.0.1', '::1', 'cafe-cloud-postgres', 'db', 'localhost', 'postgres'].sort()
      );
    });
  });

  describe('4. Remote and Cloud Hosts Rejected', () => {
    it('rejects Railway public domain in connectionString', () => {
      const config = {
        connectionString: 'postgresql://postgres:secret@containers-us-west-4.railway.app:7112/cafe_cloud_pos_test'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Host 'containers-us-west-4\.railway\.app' is not an approved local test database host/
        }
      );
    });

    it('rejects rlwy.net proxy domain', () => {
      const config = {
        host: 'roundhouse.proxy.rlwy.net',
        database: 'pos_test'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Host 'roundhouse\.proxy\.rlwy\.net' is not an approved local test database host/
        }
      );
    });

    it('rejects AWS RDS or cloud host even if database ends in _test', () => {
      const config = {
        host: 'pos-test-db.c123456.us-east-1.rds.amazonaws.com',
        database: 'pos_test'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /is not an approved local test database host/
        }
      );
    });

    it('rejects arbitrary LAN IP address not on local allowlist', () => {
      const config = {
        host: '192.168.1.100',
        database: 'cafe_cloud_pos_test'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Host '192\.168\.1\.100' is not an approved local test database host/
        }
      );
    });

    it('rejects external domain disguised with test name', () => {
      const config = {
        host: 'test-postgres.evil.com',
        database: 'cafe_test'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Host 'test-postgres\.evil\.com' is not an approved local test database host/
        }
      );
    });
  });

  describe('5. Missing Database Name Rejection', () => {
    it('rejects empty database name', () => {
      const config = {
        host: 'localhost',
        database: ''
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Database name is not specified/
        }
      );
    });

    it('rejects whitespace-only database name', () => {
      const config = {
        host: 'localhost',
        database: '   '
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Database name is not specified/
        }
      );
    });

    it('rejects null or undefined database name', () => {
      assert.throws(
        () => validateTestDatabaseSafety({ host: 'localhost' }, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Database name is not specified/
        }
      );
    });
  });

  describe('6. NODE_ENV Not Equal to "test" Rejected', () => {
    it('throws when NODE_ENV is development', () => {
      assert.throws(
        () => validateTestDatabaseSafety({ host: 'localhost', database: 'cafe_cloud_pos_test' }, { NODE_ENV: 'development' }),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /NODE_ENV must be strictly 'test'/
        }
      );
    });

    it('throws when NODE_ENV is production', () => {
      assert.throws(
        () => validateTestDatabaseSafety({ host: 'localhost', database: 'cafe_cloud_pos_test' }, { NODE_ENV: 'production' }),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /NODE_ENV must be strictly 'test'/
        }
      );
    });

    it('throws when NODE_ENV is unset or empty', () => {
      assert.throws(
        () => validateTestDatabaseSafety({ host: 'localhost', database: 'cafe_cloud_pos_test' }, {}),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /NODE_ENV must be strictly 'test'/
        }
      );
    });

    it('throws when NODE_ENV is staging or staging_test', () => {
      assert.throws(
        () => validateTestDatabaseSafety({ host: 'localhost', database: 'cafe_cloud_pos_test' }, { NODE_ENV: 'staging' }),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /NODE_ENV must be strictly 'test'/
        }
      );
    });
  });

  describe('7. PostgreSQL Connection String Validation', () => {
    it('accepts valid PostgreSQL connection string targeting localhost and test DB', () => {
      const config = {
        connectionString: 'postgresql://cafe_admin:test_pass@127.0.0.1:5432/cafe_cloud_pos_test'
      };
      const result = assertSafeTestDatabase(config, validTestEnv);
      assert.strictEqual(result.safe, true);
      assert.strictEqual(result.host, '127.0.0.1');
      assert.strictEqual(result.database, 'cafe_cloud_pos_test');
    });

    it('accepts valid postgres:// scheme targeting test database named "test"', () => {
      const config = {
        connectionString: 'postgres://localhost:5432/test'
      };
      const result = validateTestDatabaseSafety(config, validTestEnv);
      assert.strictEqual(result.safe, true);
      assert.strictEqual(result.host, 'localhost');
      assert.strictEqual(result.database, 'test');
    });

    it('throws when connectionString is unparseable junk', () => {
      const config = {
        connectionString: 'this is completely invalid as a url'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'INVALID_CONNECTION_URL',
          message: /Invalid database connection URL format/
        }
      );
    });

    it('throws when connectionString protocol is not postgres: or postgresql:', () => {
      const config = {
        connectionString: 'http://localhost:5432/cafe_test'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'INVALID_CONNECTION_URL',
          message: /Invalid connection URL protocol 'http:'/
        }
      );
    });

    it('throws when environment DATABASE_URL is malformed', () => {
      assert.throws(
        () => validateTestDatabaseSafety({}, { ...validTestEnv, DATABASE_URL: 'ftp://localhost:5432/cafe_test' }),
        {
          name: 'Error',
          code: 'INVALID_CONNECTION_URL',
          message: /Invalid connection URL protocol 'ftp:'/
        }
      );
    });

    it('rejects connection string targeting non-test database (cafe_test_production)', () => {
      const config = {
        connectionString: 'postgresql://localhost:5432/cafe_test_production'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Unsafe database name 'cafe_test_production'/
        }
      );
    });

    it('rejects connection string targeting contest_database', () => {
      const config = {
        connectionString: 'postgresql://localhost:5432/contest_database'
      };
      assert.throws(
        () => validateTestDatabaseSafety(config, validTestEnv),
        {
          name: 'Error',
          code: 'UNSAFE_TEST_DATABASE',
          message: /Unsafe database name 'contest_database'/
        }
      );
    });
  });

  describe('8. Migration Runner Test Database Guard Integration', () => {
    it('executes guard before connecting and aborts on unsafe database config when NODE_ENV is test', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'test';
        const unsafeConfig = {
          host: 'localhost',
          database: 'cafe_cloud_pos',
          port: 5432
        };
        await assert.rejects(
          async () => {
            await getClient(unsafeConfig);
          },
          {
            name: 'Error',
            code: 'UNSAFE_TEST_DATABASE',
            message: /Unsafe database name 'cafe_cloud_pos'/
          }
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('rejects remote database config in migration runner before connecting when NODE_ENV is test', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'test';
        const remoteConfig = {
          host: 'containers-us-west-4.railway.app',
          database: 'cafe_cloud_pos_test',
          port: 5432
        };
        await assert.rejects(
          async () => {
            await getClient(remoteConfig);
          },
          {
            name: 'Error',
            code: 'UNSAFE_TEST_DATABASE',
            message: /Host 'containers-us-west-4\.railway\.app' is not an approved local test database host/
          }
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('rejects missing host in migration runner before connecting when NODE_ENV is test', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'test';
        const noHostConfig = {
          database: 'cafe_cloud_pos_test'
        };
        await assert.rejects(
          async () => {
            await getClient(noHostConfig);
          },
          {
            name: 'Error',
            code: 'UNSAFE_TEST_DATABASE',
            message: /Database host is not specified/
          }
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('rejects non-test database name ending in _production in migration runner when NODE_ENV is test', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'test';
        const prodNameConfig = {
          host: 'localhost',
          database: 'cafe_test_production'
        };
        await assert.rejects(
          async () => {
            await getClient(prodNameConfig);
          },
          {
            name: 'Error',
            code: 'UNSAFE_TEST_DATABASE',
            message: /Unsafe database name 'cafe_test_production'/
          }
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });

  describe('9. Standalone Database Scripts Guard Integration (seed.js and verify.js)', () => {
    it('accepts approved local _test database in getSeedClient and getVerifyClient', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'test';
        const validConfig = {
          host: 'localhost',
          database: 'cafe_cloud_pos_test',
          port: 5432
        };

        const seedClient = getSeedClient(validConfig);
        assert.ok(seedClient, 'Seed client should be created when database is safe');
        assert.strictEqual(typeof seedClient.connect, 'function');

        const verifyClient = getVerifyClient(validConfig);
        assert.ok(verifyClient, 'Verify client should be created when database is safe');
        assert.strictEqual(typeof verifyClient.connect, 'function');
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('rejects non-test database in getSeedClient and getVerifyClient before connecting', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'test';
        const unsafeConfig = {
          host: 'localhost',
          database: 'cafe_cloud_pos',
          port: 5432
        };

        assert.throws(
          () => getSeedClient(unsafeConfig),
          {
            name: 'Error',
            code: 'UNSAFE_TEST_DATABASE',
            message: /Unsafe database name 'cafe_cloud_pos'/
          }
        );

        assert.throws(
          () => getVerifyClient(unsafeConfig),
          {
            name: 'Error',
            code: 'UNSAFE_TEST_DATABASE',
            message: /Unsafe database name 'cafe_cloud_pos'/
          }
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('rejects remote cloud host in getSeedClient and getVerifyClient before connecting', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'test';
        const remoteConfig = {
          host: 'junction.proxy.rlwy.net',
          database: 'cafe_cloud_pos_test',
          port: 5432
        };

        assert.throws(
          () => getSeedClient(remoteConfig),
          {
            name: 'Error',
            code: 'UNSAFE_TEST_DATABASE',
            message: /Host 'junction\.proxy\.rlwy\.net' is not an approved local test database host/
          }
        );

        assert.throws(
          () => getVerifyClient(remoteConfig),
          {
            name: 'Error',
            code: 'UNSAFE_TEST_DATABASE',
            message: /Host 'junction\.proxy\.rlwy\.net' is not an approved local test database host/
          }
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('rejects missing host in getSeedClient and getVerifyClient before connecting', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'test';
        const noHostConfig = {
          database: 'cafe_cloud_pos_test'
        };

        assert.throws(
          () => getSeedClient(noHostConfig),
          {
            name: 'Error',
            code: 'UNSAFE_TEST_DATABASE',
            message: /Database host is not specified/
          }
        );

        assert.throws(
          () => getVerifyClient(noHostConfig),
          {
            name: 'Error',
            code: 'UNSAFE_TEST_DATABASE',
            message: /Database host is not specified/
          }
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('preserves normal development execution when NODE_ENV is not test', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'development';
        const devConfig = {
          host: 'localhost',
          database: 'cafe_cloud_pos'
        };

        // When not in test mode, the guard should not block development database targets
        const seedClient = getSeedClient(devConfig);
        assert.ok(seedClient, 'Seed client should instantiate in development mode');

        const verifyClient = getVerifyClient(devConfig);
        assert.ok(verifyClient, 'Verify client should instantiate in development mode');
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });
});
