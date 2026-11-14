/**
 * Cafe Cloud POS - Central GST Calculation Engine
 * Implements Rule 35 inclusive tax extraction, symmetric CGST/SGST splits,
 * interstate IGST, ad-valorem cess, and exact integer-paise reconciliation.
 */

const {
  roundDiv,
  paiseToString,
  stringToPaise,
} = require('../utils/tax-decimal');

const VALID_GST_STATE_CODES = new Set([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '21', '22', '23', '24', '25', '26', '27', '28', '29', '30',
  '31', '32', '33', '34', '35', '36', '37', '38', '97', '99',
]);

const ALLOWED_SUPPLY_CLASSIFICATIONS = new Set([
  'DINE_IN',
  'TAKEAWAY',
  'COUNTER_RETAIL',
  'INTERSTATE_DELIVERY',
]);

/**
 * Calculates statutory GST and cess breakdown for a single line item.
 *
 * @param {Object} params
 * @param {bigint} params.unitPricePaise - Unit price in paise
 * @param {bigint} params.quantity - Item quantity
 * @param {boolean} params.isTaxInclusive - True if unitPrice includes taxes
 * @param {bigint} params.taxRateHundredths - Nominal GST rate in hundredths (e.g. 500n for 5%)
 * @param {bigint} [params.cessRateHundredths=0n] - Ad-valorem cess rate in hundredths
 * @param {boolean} params.isInterstate - True for inter-state (IGST), false for intra-state (CGST+SGST)
 * @returns {Object} Line calculation results in BigInt paise
 */
function calculateLineTax(params) {
  const {
    unitPricePaise,
    quantity,
    isTaxInclusive,
    taxRateHundredths,
    cessRateHundredths = 0n,
    isInterstate,
  } = params;

  if (quantity <= 0n) {
    throw new Error('Quantity must be greater than zero');
  }

  let grossAmountPaise;
  let taxableValuePaise;
  let cgstAmountPaise = 0n;
  let sgstAmountPaise = 0n;
  let igstAmountPaise = 0n;
  let cessAmountPaise = 0n;
  let roundingResidualPaise = 0n;
  let lineTotalPaise;

  if (isTaxInclusive) {
    // Tax-inclusive pricing (Rule 35 extraction)
    grossAmountPaise = unitPricePaise * quantity;
    const rTotal = taxRateHundredths + cessRateHundredths;
    const divisor = 10000n + rTotal;

    taxableValuePaise = roundDiv(grossAmountPaise * 10000n, divisor);

    if (isInterstate) {
      igstAmountPaise = roundDiv(grossAmountPaise * taxRateHundredths, divisor);
    } else {
      const rHalf = taxRateHundredths / 2n;
      cgstAmountPaise = roundDiv(grossAmountPaise * rHalf, divisor);
      sgstAmountPaise = roundDiv(grossAmountPaise * rHalf, divisor);
    }

    if (cessRateHundredths > 0n) {
      cessAmountPaise = roundDiv(grossAmountPaise * cessRateHundredths, divisor);
    }

    // Residual captures fractional-paisa integer rounding
    roundingResidualPaise =
      grossAmountPaise -
      (taxableValuePaise + cgstAmountPaise + sgstAmountPaise + igstAmountPaise + cessAmountPaise);

    // Line total preserves gross sticker amount
    lineTotalPaise =
      taxableValuePaise +
      cgstAmountPaise +
      sgstAmountPaise +
      igstAmountPaise +
      cessAmountPaise +
      roundingResidualPaise;
  } else {
    // Tax-exclusive pricing
    taxableValuePaise = unitPricePaise * quantity;

    if (isInterstate) {
      igstAmountPaise = roundDiv(taxableValuePaise * taxRateHundredths, 10000n);
    } else {
      const rHalf = taxRateHundredths / 2n;
      cgstAmountPaise = roundDiv(taxableValuePaise * rHalf, 10000n);
      sgstAmountPaise = roundDiv(taxableValuePaise * rHalf, 10000n);
    }

    if (cessRateHundredths > 0n) {
      cessAmountPaise = roundDiv(taxableValuePaise * cessRateHundredths, 10000n);
    }

    roundingResidualPaise = 0n;
    grossAmountPaise =
      taxableValuePaise + cgstAmountPaise + sgstAmountPaise + igstAmountPaise + cessAmountPaise;
    lineTotalPaise = grossAmountPaise;
  }

  return {
    grossAmountPaise,
    taxableValuePaise,
    cgstAmountPaise,
    sgstAmountPaise,
    igstAmountPaise,
    cessAmountPaise,
    roundingResidualPaise,
    lineTotalPaise,
  };
}

/**
 * Resolves statutory place-of-supply context and determines interstate flag.
 *
 * @param {string} companyStateCode - 2-digit store state code
 * @param {string} supplyClassification - Canonical transaction classification
 * @param {string} [destinationStateCode] - Destination state for deliveries
 * @returns {{ isInterstate: boolean, placeOfSupplyStateCode: string }}
 */
function resolvePlaceOfSupply(companyStateCode, supplyClassification, destinationStateCode) {
  if (!ALLOWED_SUPPLY_CLASSIFICATIONS.has(supplyClassification)) {
    const err = new Error(
      `Unsupported supply classification: "${supplyClassification}". Allowed: ${Array.from(ALLOWED_SUPPLY_CLASSIFICATIONS).join(', ')}`
    );
    err.code = 'UNSUPPORTED_SUPPLY_CLASSIFICATION';
    err.statusCode = 400;
    throw err;
  }

  if (supplyClassification === 'INTERSTATE_DELIVERY') {
    if (!destinationStateCode || typeof destinationStateCode !== 'string') {
      const err = new Error(
        'Missing destinationStateCode for supplyClassification "INTERSTATE_DELIVERY".'
      );
      err.code = 'MISSING_OR_INVALID_DESTINATION_STATE';
      err.statusCode = 400;
      throw err;
    }

    const trimmedDest = destinationStateCode.trim();
    if (!VALID_GST_STATE_CODES.has(trimmedDest)) {
      const err = new Error(
        `Invalid destinationStateCode: "${destinationStateCode}". Must be a valid 2-digit Indian GST state code.`
      );
      err.code = 'MISSING_OR_INVALID_DESTINATION_STATE';
      err.statusCode = 400;
      throw err;
    }

    const isInterstate = trimmedDest !== companyStateCode;
    return {
      isInterstate,
      placeOfSupplyStateCode: trimmedDest,
    };
  }

  // Counter transactions (DINE_IN, TAKEAWAY, COUNTER_RETAIL)
  if (destinationStateCode !== undefined && destinationStateCode !== null && destinationStateCode !== '') {
    const err = new Error(
      `destinationStateCode is not allowed for supplyClassification "${supplyClassification}". Place of supply is statutorily fixed to store location.`
    );
    err.code = 'IRRELEVANT_DESTINATION_STATE';
    err.statusCode = 400;
    throw err;
  }

  return {
    isInterstate: false,
    placeOfSupplyStateCode: companyStateCode,
  };
}

module.exports = {
  VALID_GST_STATE_CODES,
  ALLOWED_SUPPLY_CLASSIFICATIONS,
  calculateLineTax,
  resolvePlaceOfSupply,
};
