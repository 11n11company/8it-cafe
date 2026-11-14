/**
 * Cafe Cloud POS - Tax & Decimal Precision Utility
 * Enforces zero floating-point arithmetic using native BigInt and exact string parsing.
 */

/**
 * Validates tax rate percentage string, enforces NUMERIC(5,2) bounds,
 * and derives symmetric CGST/SGST and IGST rates using BigInt arithmetic.
 *
 * @param {unknown} input - Raw rate input from request
 * @returns {{ ratePercentage: string, cgstRate: string, sgstRate: string, igstRate: string, hundredths: bigint }}
 */
function validateAndDeriveTaxRate(input) {
  if (typeof input !== 'string') {
    const err = new Error('Rate percentage must be provided as a decimal string, e.g. "5.00".');
    err.code = 'INVALID_TYPE';
    err.statusCode = 400;
    throw err;
  }

  const trimmed = input.trim();
  const match = trimmed.match(/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/);
  if (!match) {
    const err = new Error(
      `Rate percentage "${trimmed}" is invalid. Must be a non-negative decimal string with at most 2 decimal places.`
    );
    err.code = 'INVALID_FORMAT';
    err.statusCode = 400;
    throw err;
  }

  const wholeStr = match[1];
  const fracStr = (match[2] || '').padEnd(2, '0');

  const wholeBig = BigInt(wholeStr);
  const fracBig = BigInt(fracStr);
  const hundredths = wholeBig * 100n + fracBig;

  // Maximum NUMERIC(5, 2) value is 999.99 (99,999 hundredths)
  if (hundredths > 99999n) {
    const err = new Error(
      `Rate percentage "${trimmed}" exceeds maximum supported rate of 999.99%.`
    );
    err.code = 'RATE_OUT_OF_RANGE';
    err.statusCode = 400;
    throw err;
  }

  // Parity check: must be even to split equally into two 2-decimal numbers
  if (hundredths % 2n !== 0n) {
    const err = new Error(
      `Tax rate percentage "${trimmed}%" cannot be divided into equal two-decimal CGST and SGST rates (requires even hundredths).`
    );
    err.code = 'INVALID_TAX_RATE_SPLIT';
    err.statusCode = 400;
    throw err;
  }

  const half = hundredths / 2n;
  const halfWhole = half / 100n;
  const halfFrac = (half % 100n).toString().padStart(2, '0');

  const canonicalRate = `${wholeStr}.${fracStr}`;
  const splitRate = `${halfWhole}.${halfFrac}`;

  return {
    ratePercentage: canonicalRate,
    cgstRate: splitRate,
    sgstRate: splitRate,
    igstRate: canonicalRate,
    hundredths,
  };
}

/**
 * Validates cess rate percentage string and enforces NUMERIC(5,2) bounds.
 *
 * @param {unknown} input - Raw cess rate input
 * @returns {{ cessRate: string, hundredths: bigint }}
 */
function validateCessRate(input) {
  if (input === undefined || input === null || input === '') {
    return { cessRate: '0.00', hundredths: 0n };
  }

  if (typeof input !== 'string') {
    const err = new Error('Cess rate must be provided as a decimal string, e.g. "0.00".');
    err.code = 'INVALID_TYPE';
    err.statusCode = 400;
    throw err;
  }

  const trimmed = input.trim();
  const match = trimmed.match(/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/);
  if (!match) {
    const err = new Error(
      `Cess rate "${trimmed}" is invalid. Must be a non-negative decimal string with at most 2 decimal places.`
    );
    err.code = 'INVALID_FORMAT';
    err.statusCode = 400;
    throw err;
  }

  const wholeStr = match[1];
  const fracStr = (match[2] || '').padEnd(2, '0');

  const wholeBig = BigInt(wholeStr);
  const fracBig = BigInt(fracStr);
  const hundredths = wholeBig * 100n + fracBig;

  if (hundredths > 99999n) {
    const err = new Error(
      `Cess rate "${trimmed}" exceeds maximum supported rate of 999.99%.`
    );
    err.code = 'CESS_RATE_OUT_OF_RANGE';
    err.statusCode = 400;
    throw err;
  }

  return {
    cessRate: `${wholeStr}.${fracStr}`,
    hundredths,
  };
}

/**
 * Deterministic half-up integer division using BigInt:
 * roundDiv(N, D) = floor((N + floor(D / 2)) / D)
 *
 * @param {bigint} numerator
 * @param {bigint} denominator
 * @returns {bigint}
 */
function roundDiv(numerator, denominator) {
  if (denominator === 0n) {
    throw new Error('Division by zero in tax calculation');
  }
  const halfDenom = denominator / 2n;
  return (numerator + halfDenom) / denominator;
}

/**
 * Converts integer paise BigInt to fixed 2-decimal string format.
 *
 * @param {bigint} paise
 * @returns {string}
 */
function paiseToString(paise) {
  const isNegative = paise < 0n;
  const absPaise = isNegative ? -paise : paise;
  const whole = absPaise / 100n;
  const frac = (absPaise % 100n).toString().padStart(2, '0');
  return `${isNegative ? '-' : ''}${whole}.${frac}`;
}

/**
 * Converts a decimal monetary string (e.g. "150.00") to integer paise BigInt.
 *
 * @param {string|number} decimalStr
 * @returns {bigint}
 */
function stringToPaise(decimalStr) {
  const str = String(decimalStr).trim();
  const match = str.match(/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new Error(`Invalid monetary amount: "${decimalStr}"`);
  }
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] || '').padEnd(2, '0'));
  return whole * 100n + frac;
}

module.exports = {
  validateAndDeriveTaxRate,
  validateCessRate,
  roundDiv,
  paiseToString,
  stringToPaise,
};
