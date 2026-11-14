/**
 * Unit Tests for Tax & Decimal Precision Utility
 * node --test backend/tests/tax-decimal.unit.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateAndDeriveTaxRate,
  validateCessRate,
  roundDiv,
  paiseToString,
  stringToPaise,
} = require('../src/utils/tax-decimal');

describe('Tax Decimal Precision Utility', () => {
  describe('validateAndDeriveTaxRate', () => {
    it('rejects JavaScript numeric values', () => {
      assert.throws(
        () => validateAndDeriveTaxRate(5.0),
        (err) => err.code === 'INVALID_TYPE' && err.statusCode === 400
      );
      assert.throws(
        () => validateAndDeriveTaxRate(18),
        (err) => err.code === 'INVALID_TYPE' && err.statusCode === 400
      );
    });

    it('rejects negative values', () => {
      assert.throws(
        () => validateAndDeriveTaxRate('-5.00'),
        (err) => err.code === 'INVALID_FORMAT' && err.statusCode === 400
      );
    });

    it('rejects malformed strings', () => {
      const malformed = ['abc', '5.', '.50', '5.0.0', '', '  '];
      for (const val of malformed) {
        assert.throws(
          () => validateAndDeriveTaxRate(val),
          (err) => err.code === 'INVALID_FORMAT' && err.statusCode === 400,
          `Expected ${val} to be rejected as INVALID_FORMAT`
        );
      }
    });

    it('rejects values with more than two decimal places', () => {
      assert.throws(
        () => validateAndDeriveTaxRate('5.001'),
        (err) => err.code === 'INVALID_FORMAT' && err.statusCode === 400
      );
    });

    it('rejects values greater than 999.99%', () => {
      assert.throws(
        () => validateAndDeriveTaxRate('1000.00'),
        (err) => err.code === 'RATE_OUT_OF_RANGE' && err.statusCode === 400
      );
      assert.throws(
        () => validateAndDeriveTaxRate('9999.99'),
        (err) => err.code === 'RATE_OUT_OF_RANGE' && err.statusCode === 400
      );
    });

    it('rejects odd hundredths rates (5.01%, 0.05%, 18.03%)', () => {
      const oddRates = ['5.01', '0.05', '18.03', '12.01'];
      for (const rate of oddRates) {
        assert.throws(
          () => validateAndDeriveTaxRate(rate),
          (err) => err.code === 'INVALID_TAX_RATE_SPLIT' && err.statusCode === 400,
          `Expected odd rate ${rate} to be rejected as INVALID_TAX_RATE_SPLIT`
        );
      }
    });

    it('accepts valid even hundredths rates and derives exact canonical splits', () => {
      const cases = [
        {
          input: '0.00',
          expected: { ratePercentage: '0.00', cgstRate: '0.00', sgstRate: '0.00', igstRate: '0.00' }
        },
        {
          input: '5.00',
          expected: { ratePercentage: '5.00', cgstRate: '2.50', sgstRate: '2.50', igstRate: '5.00' }
        },
        {
          input: '5.02',
          expected: { ratePercentage: '5.02', cgstRate: '2.51', sgstRate: '2.51', igstRate: '5.02' }
        },
        {
          input: '18.00',
          expected: { ratePercentage: '18.00', cgstRate: '9.00', sgstRate: '9.00', igstRate: '18.00' }
        },
        {
          input: '28.00',
          expected: { ratePercentage: '28.00', cgstRate: '14.00', sgstRate: '14.00', igstRate: '28.00' }
        },
        {
          input: '999.98',
          expected: { ratePercentage: '999.98', cgstRate: '499.99', sgstRate: '499.99', igstRate: '999.98' }
        }
      ];

      for (const { input, expected } of cases) {
        const res = validateAndDeriveTaxRate(input);
        assert.equal(res.ratePercentage, expected.ratePercentage);
        assert.equal(res.cgstRate, expected.cgstRate);
        assert.equal(res.sgstRate, expected.sgstRate);
        assert.equal(res.igstRate, expected.igstRate);
      }
    });
  });

  describe('validateCessRate', () => {
    it('defaults to 0.00 for empty or null', () => {
      assert.deepEqual(validateCessRate(), { cessRate: '0.00', hundredths: 0n });
      assert.deepEqual(validateCessRate(null), { cessRate: '0.00', hundredths: 0n });
      assert.deepEqual(validateCessRate(''), { cessRate: '0.00', hundredths: 0n });
    });

    it('rejects numbers', () => {
      assert.throws(
        () => validateCessRate(12.0),
        (err) => err.code === 'INVALID_TYPE'
      );
    });

    it('validates and formats valid cess rate string', () => {
      const res = validateCessRate('12.00');
      assert.equal(res.cessRate, '12.00');
      assert.equal(res.hundredths, 1200n);
    });
  });

  describe('roundDiv', () => {
    it('performs exact half-up integer division', () => {
      // 5 / 10 = 0.5 -> 1
      assert.equal(roundDiv(5n, 10n), 1n);
      // 4 / 10 = 0.4 -> 0
      assert.equal(roundDiv(4n, 10n), 0n);
      // 15 / 10 = 1.5 -> 2
      assert.equal(roundDiv(15n, 10n), 2n);
      // 14 / 10 = 1.4 -> 1
      assert.equal(roundDiv(14n, 10n), 1n);
    });
  });

  describe('paiseToString and stringToPaise', () => {
    it('converts BigInt paise to signed 2-decimal strings', () => {
      assert.equal(paiseToString(0n), '0.00');
      assert.equal(paiseToString(1n), '0.01');
      assert.equal(paiseToString(28571n), '285.71');
      assert.equal(paiseToString(-1n), '-0.01');
      assert.equal(paiseToString(-28571n), '-285.71');
    });

    it('converts monetary decimal string to BigInt paise', () => {
      assert.equal(stringToPaise('150.00'), 15000n);
      assert.equal(stringToPaise('0.01'), 1n);
      assert.equal(stringToPaise('0.00'), 0n);
      assert.equal(stringToPaise('120'), 12000n);
    });
  });
});
