/**
 * Unit Tests for Central GST Calculation Service
 * node --test backend/tests/gst-calculation.unit.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateLineTax,
  resolvePlaceOfSupply,
} = require('../src/services/gst-calculation.service');

describe('GST Calculation Engine Unit Tests', () => {
  describe('calculateLineTax - 5% Tax-Inclusive Item', () => {
    const baseParams = {
      unitPricePaise: 15000n, // Rs 150.00
      quantity: 2n,          // Gross = Rs 300.00 (30,000 paise)
      isTaxInclusive: true,
      taxRateHundredths: 500n, // 5.00%
      cessRateHundredths: 0n,
    };

    it('Scenario 1A: Intra-State (CGST 2.5%, SGST 2.5%, IGST 0%) with 1 paisa residual', () => {
      const res = calculateLineTax({ ...baseParams, isInterstate: false });
      assert.equal(res.grossAmountPaise, 30000n);
      assert.equal(res.taxableValuePaise, 28571n); // Rs 285.71
      assert.equal(res.cgstAmountPaise, 714n);     // Rs 7.14
      assert.equal(res.sgstAmountPaise, 714n);     // Rs 7.14
      assert.equal(res.igstAmountPaise, 0n);
      assert.equal(res.cessAmountPaise, 0n);
      assert.equal(res.roundingResidualPaise, 1n); // 30000 - (28571 + 714 + 714) = 1
      assert.equal(res.lineTotalPaise, 30000n);    // Exact reconciliation
    });

    it('Scenario 1B: Inter-State (CGST 0%, SGST 0%, IGST 5.0%) with 0 residual', () => {
      const res = calculateLineTax({ ...baseParams, isInterstate: true });
      assert.equal(res.grossAmountPaise, 30000n);
      assert.equal(res.taxableValuePaise, 28571n);
      assert.equal(res.cgstAmountPaise, 0n);
      assert.equal(res.sgstAmountPaise, 0n);
      assert.equal(res.igstAmountPaise, 1429n);    // Rs 14.29
      assert.equal(res.cessAmountPaise, 0n);
      assert.equal(res.roundingResidualPaise, 0n); // 30000 - (28571 + 1429) = 0
      assert.equal(res.lineTotalPaise, 30000n);
    });
  });

  describe('calculateLineTax - 18% Tax-Inclusive Item', () => {
    const baseParams = {
      unitPricePaise: 12000n, // Rs 120.00
      quantity: 1n,          // Gross = Rs 120.00 (12,000 paise)
      isTaxInclusive: true,
      taxRateHundredths: 1800n, // 18.00%
      cessRateHundredths: 0n,
    };

    it('Scenario 2A: Intra-State (CGST 9%, SGST 9%) with 1 paisa residual', () => {
      const res = calculateLineTax({ ...baseParams, isInterstate: false });
      assert.equal(res.grossAmountPaise, 12000n);
      assert.equal(res.taxableValuePaise, 10169n); // Rs 101.69
      assert.equal(res.cgstAmountPaise, 915n);     // Rs 9.15
      assert.equal(res.sgstAmountPaise, 915n);     // Rs 9.15
      assert.equal(res.igstAmountPaise, 0n);
      assert.equal(res.roundingResidualPaise, 1n); // 12000 - (10169 + 915 + 915) = 1
      assert.equal(res.lineTotalPaise, 12000n);
    });

    it('Scenario 2B: Inter-State (IGST 18%) with 0 residual', () => {
      const res = calculateLineTax({ ...baseParams, isInterstate: true });
      assert.equal(res.grossAmountPaise, 12000n);
      assert.equal(res.taxableValuePaise, 10169n);
      assert.equal(res.cgstAmountPaise, 0n);
      assert.equal(res.sgstAmountPaise, 0n);
      assert.equal(res.igstAmountPaise, 1831n);    // Rs 18.31
      assert.equal(res.roundingResidualPaise, 0n);
      assert.equal(res.lineTotalPaise, 12000n);
    });
  });

  describe('calculateLineTax - Non-Zero Cess (28% GST + 12% Cess)', () => {
    it('Inclusive non-zero cess intra-state calculation', () => {
      const res = calculateLineTax({
        unitPricePaise: 25000n, // Rs 250.00
        quantity: 1n,
        isTaxInclusive: true,
        taxRateHundredths: 2800n,  // 28.00%
        cessRateHundredths: 1200n, // 12.00%
        isInterstate: false,
      });

      assert.equal(res.grossAmountPaise, 25000n);
      assert.equal(res.taxableValuePaise, 17857n); // Rs 178.57
      assert.equal(res.cgstAmountPaise, 2500n);     // Rs 25.00
      assert.equal(res.sgstAmountPaise, 2500n);     // Rs 25.00
      assert.equal(res.igstAmountPaise, 0n);
      assert.equal(res.cessAmountPaise, 2143n);     // Rs 21.43
      assert.equal(res.roundingResidualPaise, 0n);  // 25000 - (17857 + 2500 + 2500 + 2143) = 0
      assert.equal(res.lineTotalPaise, 25000n);
    });

    it('Inclusive non-zero cess with 1 paisa residual', () => {
      // Gross = Rs 12.74 (1,274 paise)
      // D = 14,000
      // Taxable = roundDiv(1274 * 10000, 14000) = 910 paise (Rs 9.10)
      // CGST = roundDiv(1274 * 1400, 14000) = 127 paise (Rs 1.27)
      // SGST = roundDiv(1274 * 1400, 14000) = 127 paise (Rs 1.27)
      // Cess = roundDiv(1274 * 1200, 14000) = 109 paise (Rs 1.09)
      // Sum = 910 + 127 + 127 + 109 = 1273 paise (Rs 12.73)
      // Residual = 1274 - 1273 = 1 paisa
      const res = calculateLineTax({
        unitPricePaise: 1274n,
        quantity: 1n,
        isTaxInclusive: true,
        taxRateHundredths: 2800n,
        cessRateHundredths: 1200n,
        isInterstate: false,
      });

      assert.equal(res.grossAmountPaise, 1274n);
      assert.equal(res.taxableValuePaise, 910n);
      assert.equal(res.cgstAmountPaise, 127n);
      assert.equal(res.sgstAmountPaise, 127n);
      assert.equal(res.cessAmountPaise, 109n);
      assert.equal(res.roundingResidualPaise, 1n);
      assert.equal(res.lineTotalPaise, 1274n);
    });

    it('Exclusive non-zero cess intra-state calculation', () => {
      const res = calculateLineTax({
        unitPricePaise: 20000n, // Base Rs 200.00
        quantity: 1n,
        isTaxInclusive: false,
        taxRateHundredths: 2800n,  // 28.00%
        cessRateHundredths: 1200n, // 12.00%
        isInterstate: false,
      });

      assert.equal(res.taxableValuePaise, 20000n); // Rs 200.00
      assert.equal(res.cgstAmountPaise, 2800n);     // Rs 28.00
      assert.equal(res.sgstAmountPaise, 2800n);     // Rs 28.00
      assert.equal(res.igstAmountPaise, 0n);
      assert.equal(res.cessAmountPaise, 2400n);     // Rs 24.00
      assert.equal(res.roundingResidualPaise, 0n);
      assert.equal(res.grossAmountPaise, 28000n);   // Rs 280.00
      assert.equal(res.lineTotalPaise, 28000n);
    });
  });

  describe('resolvePlaceOfSupply', () => {
    it('resolves counter transaction (DINE_IN, TAKEAWAY, COUNTER_RETAIL) to store state', () => {
      const classifications = ['DINE_IN', 'TAKEAWAY', 'COUNTER_RETAIL'];
      for (const classification of classifications) {
        const res = resolvePlaceOfSupply('29', classification);
        assert.equal(res.isInterstate, false);
        assert.equal(res.placeOfSupplyStateCode, '29');
      }
    });

    it('rejects irrelevant destinationStateCode for counter transactions', () => {
      assert.throws(
        () => resolvePlaceOfSupply('29', 'DINE_IN', '33'),
        (err) => err.code === 'IRRELEVANT_DESTINATION_STATE'
      );
      assert.throws(
        () => resolvePlaceOfSupply('29', 'TAKEAWAY', '33'),
        (err) => err.code === 'IRRELEVANT_DESTINATION_STATE'
      );
      assert.throws(
        () => resolvePlaceOfSupply('29', 'COUNTER_RETAIL', '29'),
        (err) => err.code === 'IRRELEVANT_DESTINATION_STATE'
      );
    });

    it('resolves INTERSTATE_DELIVERY correctly', () => {
      // Cross-border delivery (store in Karnataka 29, dest in Tamil Nadu 33)
      const resDiff = resolvePlaceOfSupply('29', 'INTERSTATE_DELIVERY', '33');
      assert.equal(resDiff.isInterstate, true);
      assert.equal(resDiff.placeOfSupplyStateCode, '33');

      // Local delivery in same state
      const resSame = resolvePlaceOfSupply('29', 'INTERSTATE_DELIVERY', '29');
      assert.equal(resSame.isInterstate, false);
      assert.equal(resSame.placeOfSupplyStateCode, '29');
    });

    it('rejects missing or invalid destinationStateCode for INTERSTATE_DELIVERY', () => {
      assert.throws(
        () => resolvePlaceOfSupply('29', 'INTERSTATE_DELIVERY'),
        (err) => err.code === 'MISSING_OR_INVALID_DESTINATION_STATE'
      );
      assert.throws(
        () => resolvePlaceOfSupply('29', 'INTERSTATE_DELIVERY', '999'),
        (err) => err.code === 'MISSING_OR_INVALID_DESTINATION_STATE'
      );
      assert.throws(
        () => resolvePlaceOfSupply('29', 'INTERSTATE_DELIVERY', 'XX'),
        (err) => err.code === 'MISSING_OR_INVALID_DESTINATION_STATE'
      );
    });

    it('rejects OVER_THE_COUNTER and unsupported classifications', () => {
      assert.throws(
        () => resolvePlaceOfSupply('29', 'OVER_THE_COUNTER'),
        (err) => err.code === 'UNSUPPORTED_SUPPLY_CLASSIFICATION'
      );
      assert.throws(
        () => resolvePlaceOfSupply('29', 'EXPORT'),
        (err) => err.code === 'UNSUPPORTED_SUPPLY_CLASSIFICATION'
      );
    });
  });
});
