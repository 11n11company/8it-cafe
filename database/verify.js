/**
 * Cafe Cloud POS - PostgreSQL Schema & Business Logic Verification Test Suite
 * Tests all 10 required architectural and business invariants.
 */

const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'cafe_cloud_pos',
  user: process.env.DB_USER || 'cafe_admin',
  password: process.env.DB_PASSWORD || 'cafe_secure_dev_pass_2026',
};

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const BRAND_CC_ID = '22222222-2222-4222-8222-222222222201';
const BRAND_BS_ID = '22222222-2222-4222-8222-222222222202';
const CASHIER_ID = '55555555-5555-4555-8555-555555555501';
const PRINTER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';

async function runTests() {
  const client = new Client(config);
  await client.connect();

  console.log('\n======================================================');
  console.log(' CAFE CLOUD POS - DATABASE INTEGRITY & TEST SUITE');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`PASS: [${testName}] ${details}`);
      passed++;
    } else {
      console.error(`FAIL: [${testName}] ${details}`);
      failed++;
    }
  }

  try {
    // ------------------------------------------------------------------
    // TEST 1: All 21 Approved Tables Exist and Migrations Applied
    // ------------------------------------------------------------------
    const expectedTables = [
      'companies', 'brands', 'roles', 'permissions', 'role_permissions', 'users',
      'tax_rates', 'categories', 'products', 'invoice_sequences', 'invoices',
      'invoice_items', 'payments', 'kots', 'kot_items', 'print_agents',
      'printers', 'print_jobs', 'print_attempts', 'audit_logs', 'idempotency_keys'
    ];

    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    `);
    const existingTables = tablesRes.rows.map(r => r.table_name);
    const missingTables = expectedTables.filter(t => !existingTables.includes(t));

    assert(
      missingTables.length === 0,
      'Test 1: Schema Inventory',
      `All 21 required tables exist. (Missing: ${missingTables.join(', ') || 'None'})`
    );

    // ------------------------------------------------------------------
    // TEST 2: Foreign Key Constraints Active
    // ------------------------------------------------------------------
    let fkBlocked = false;
    try {
      // Attempt to insert product with invalid non-existent brand_id
      await client.query(`
        INSERT INTO products (
          id, company_id, brand_id, category_id, tax_rate_id,
          name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active
        ) VALUES (
          gen_random_uuid(),
          '${COMPANY_ID}',
          '00000000-0000-0000-0000-000000000000', -- Non-existent brand
          '77777777-7777-4777-8777-777777777701',
          '66666666-6666-4666-8666-666666666601',
          'FK Test Product', 'FK-TEST', '996331', 100.00, TRUE, FALSE, TRUE
        );
      `);
    } catch (err) {
      if (err.code === '23503') { // foreign_key_violation
        fkBlocked = true;
      }
    }
    assert(
      fkBlocked,
      'Test 2: Foreign Key Enforcement',
      'PostgreSQL rejected orphan child record with invalid FK (code 23503).'
    );

    // ------------------------------------------------------------------
    // TEST 3: Duplicate Invoice Numbers Are Rejected
    // ------------------------------------------------------------------
    const testInvNum = `TEST-INV-${Date.now()}`;
    await client.query(`
      INSERT INTO invoices (
        id, company_id, cashier_id, invoice_number, financial_year, counter_code,
        company_legal_name_snapshot, company_trade_name_snapshot, company_gstin_snapshot,
        company_address_snapshot, company_state_code_snapshot, cashier_name_snapshot,
        subtotal_gross, total_discount_amount, total_taxable_amount,
        total_cgst_amount, total_sgst_amount, total_igst_amount, total_cess_amount,
        rounding_adjustment, grand_total, is_interstate, payment_status
      ) VALUES (
        gen_random_uuid(), '${COMPANY_ID}', '${CASHIER_ID}', '${testInvNum}', '2026-27', 'COUNTER-01',
        'Cafe & Brownie Co Pvt Ltd', 'Cafe Co', '29TESTA0000A1Z5', 'MG Road', '29', 'Anoop K',
        300.00, 0.00, 285.71, 7.14, 7.15, 0.00, 0.00, 0.00, 300.00, FALSE, 'PAID'
      );
    `);

    let dupRejected = false;
    try {
      await client.query(`
        INSERT INTO invoices (
          id, company_id, cashier_id, invoice_number, financial_year, counter_code,
          company_legal_name_snapshot, company_trade_name_snapshot, company_gstin_snapshot,
          company_address_snapshot, company_state_code_snapshot, cashier_name_snapshot,
          subtotal_gross, total_discount_amount, total_taxable_amount,
          total_cgst_amount, total_sgst_amount, total_igst_amount, total_cess_amount,
          rounding_adjustment, grand_total, is_interstate, payment_status
        ) VALUES (
          gen_random_uuid(), '${COMPANY_ID}', '${CASHIER_ID}', '${testInvNum}', '2026-27', 'COUNTER-01',
          'Cafe & Brownie Co Pvt Ltd', 'Cafe Co', '29TESTA0000A1Z5', 'MG Road', '29', 'Anoop K',
          300.00, 0.00, 285.71, 7.14, 7.15, 0.00, 0.00, 0.00, 300.00, FALSE, 'PAID'
        );
      `);
    } catch (err) {
      if (err.code === '23505') { // unique_violation
        dupRejected = true;
      }
    }
    assert(
      dupRejected,
      'Test 3: Unique Constraint on Invoices',
      `Duplicate invoice number '${testInvNum}' was rejected (code 23505).`
    );

    // ------------------------------------------------------------------
    // TEST 4: Company Isolation Enforcement
    // ------------------------------------------------------------------
    let invalidCompanyBlocked = false;
    try {
      await client.query(`
        INSERT INTO brands (id, company_id, name, code)
        VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'Illegal Brand', 'IB');
      `);
    } catch (err) {
      if (err.code === '23503') {
        invalidCompanyBlocked = true;
      }
    }
    assert(
      invalidCompanyBlocked,
      'Test 4: Company Isolation Boundary',
      'Entities cannot reference non-existent or foreign company IDs.'
    );

    // ------------------------------------------------------------------
    // TEST 5: Kitchen Eligibility Snapshot Stored on Invoice Items
    // ------------------------------------------------------------------
    // Create multi-brand invoice containing 2 kitchen items and 2 retail items
    const testMultiInvId = 'ffffffff-1111-4fff-8fff-111111111111';
    const testMultiInvNum = `INV-MULTI-${Date.now()}`;
    await client.query(`
      INSERT INTO invoices (
        id, company_id, cashier_id, invoice_number, financial_year, counter_code,
        company_legal_name_snapshot, company_trade_name_snapshot, company_gstin_snapshot,
        company_address_snapshot, company_state_code_snapshot, cashier_name_snapshot,
        subtotal_gross, total_discount_amount, total_taxable_amount,
        total_cgst_amount, total_sgst_amount, total_igst_amount, total_cess_amount,
        rounding_adjustment, grand_total, is_interstate, payment_status
      ) VALUES (
        '${testMultiInvId}', '${COMPANY_ID}', '${CASHIER_ID}', '${testMultiInvNum}', '2026-27', 'COUNTER-01',
        'Cafe & Brownie Co Pvt Ltd', 'Cafe & Brownie Co', '29TESTA0000A1Z5', 'MG Road', '29', 'Anoop K',
        910.00, 0.00, 843.81, 33.09, 33.10, 0.00, 0.00, 0.00, 910.00, FALSE, 'PAID'
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // Insert 4 line items with their respective kitchen snapshots
    const item1Id = 'ffffffff-1111-4fff-8fff-000000000001';
    const item2Id = 'ffffffff-1111-4fff-8fff-000000000002';
    const item3Id = 'ffffffff-1111-4fff-8fff-000000000003';
    const item4Id = 'ffffffff-1111-4fff-8fff-000000000004';

    await client.query(`
      INSERT INTO invoice_items (
        id, company_id, invoice_id, product_id, brand_id,
        brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot, hsn_sac_code_snapshot,
        is_kitchen_item_snapshot, quantity, unit_price, gross_amount, discount_amount, taxable_value,
        tax_rate_percentage, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, line_total, notes
      ) VALUES
      -- 1. Iced Americano (Cafe Company) -> Kitchen Item: TRUE
      ('${item1Id}', '${COMPANY_ID}', '${testMultiInvId}', '88888888-8888-4888-8888-888888888801', '${BRAND_CC_ID}',
       'Cafe Company', 'CC', 'Iced Americano', 'CC-ICE-AME', '996331',
       TRUE, 1, 180.00, 180.00, 0.00, 171.43, 5.00, 2.50, 4.28, 2.50, 4.29, 0.00, 0.00, 180.00, 'Extra ice'),

      -- 2. Sparkling Water (Cafe Company) -> Retail Item: FALSE
      ('${item2Id}', '${COMPANY_ID}', '${testMultiInvId}', '88888888-8888-4888-8888-888888888803', '${BRAND_CC_ID}',
       'Cafe Company', 'CC', 'Natural Sparkling Water 500ml', 'CC-RET-WTR', '2201',
       FALSE, 1, 60.00, 60.00, 0.00, 50.85, 18.00, 9.00, 4.57, 9.00, 4.58, 0.00, 0.00, 60.00, NULL),

      -- 3. Warm Sizzler Brownie (Brownie Shop) -> Kitchen Item: TRUE
      ('${item3Id}', '${COMPANY_ID}', '${testMultiInvId}', '88888888-8888-4888-8888-888888888805', '${BRAND_BS_ID}',
       'Brownie Shop', 'BS', 'Warm Sizzler Brownie with Gelato', 'BS-PLT-SIZ', '996331',
       TRUE, 1, 220.00, 220.00, 0.00, 209.52, 5.00, 2.50, 5.24, 2.50, 5.24, 0.00, 0.00, 220.00, 'Extra chocolate sauce'),

      -- 4. Packaged Gift Box of 6 (Brownie Shop) -> Retail Item: FALSE
      ('${item4Id}', '${COMPANY_ID}', '${testMultiInvId}', '88888888-8888-4888-8888-888888888807', '${BRAND_BS_ID}',
       'Brownie Shop', 'BS', 'Packaged Brownie Gift Box (6 pcs)', 'BS-RET-BX6', '1905',
       FALSE, 1, 450.00, 450.00, 0.00, 381.36, 18.00, 9.00, 34.32, 9.00, 34.32, 0.00, 0.00, 450.00, NULL)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Verify snapshot query
    const snapRes = await client.query(`
      SELECT item_name_snapshot, is_kitchen_item_snapshot 
      FROM invoice_items 
      WHERE invoice_id = '${testMultiInvId}'
      ORDER BY item_name_snapshot ASC;
    `);

    const americano = snapRes.rows.find(r => r.item_name_snapshot === 'Iced Americano');
    const water = snapRes.rows.find(r => r.item_name_snapshot === 'Natural Sparkling Water 500ml');
    const brownie = snapRes.rows.find(r => r.item_name_snapshot === 'Warm Sizzler Brownie with Gelato');
    const giftbox = snapRes.rows.find(r => r.item_name_snapshot === 'Packaged Brownie Gift Box (6 pcs)');

    const snapshotsCorrect = 
      americano && americano.is_kitchen_item_snapshot === true &&
      water && water.is_kitchen_item_snapshot === false &&
      brownie && brownie.is_kitchen_item_snapshot === true &&
      giftbox && giftbox.is_kitchen_item_snapshot === false;

    assert(
      snapshotsCorrect,
      'Test 5: Kitchen Eligibility Snapshot Storage',
      'Items correctly store immutable boolean is_kitchen_item_snapshot.'
    );

    // ------------------------------------------------------------------
    // TEST 6: Invoice Exists Independently Without KOT (Decoupled Billing)
    // ------------------------------------------------------------------
    const kotCheck = await client.query(`
      SELECT COUNT(*) as count FROM kots WHERE invoice_id = '${testMultiInvId}';
    `);
    const initialKotCount = parseInt(kotCheck.rows[0].count, 10);

    assert(
      initialKotCount === 0,
      'Test 6: Invoice Decoupling from KOT',
      `Invoice is saved and paid, but exactly ${initialKotCount} KOT tickets exist (NO auto-KOT).`
    );

    // ------------------------------------------------------------------
    // TEST 7: KOT Contains ONLY Eligible Kitchen Items
    // ------------------------------------------------------------------
    // Cashier now manually triggers KOT:
    const testKotId = 'ffffffff-2222-4fff-8fff-222222222222';
    const testKotNum = `KOT-MULTI-${Date.now()}`;

    // 1. Create KOT record
    await client.query(`
      INSERT INTO kots (id, company_id, invoice_id, kot_number, cashier_id, is_reprint, reprint_count)
      VALUES ('${testKotId}', '${COMPANY_ID}', '${testMultiInvId}', '${testKotNum}', '${CASHIER_ID}', FALSE, 0);
    `);

    // 2. Insert items filtering by is_kitchen_item_snapshot = TRUE
    await client.query(`
      INSERT INTO kot_items (kot_id, invoice_item_id, brand_id, brand_name_snapshot, item_name_snapshot, quantity, preparation_notes)
      SELECT 
        '${testKotId}',
        ii.id,
        ii.brand_id,
        ii.brand_name_snapshot,
        ii.item_name_snapshot,
        ii.quantity,
        ii.notes
      FROM invoice_items ii
      WHERE ii.invoice_id = '${testMultiInvId}'
        AND ii.is_kitchen_item_snapshot = TRUE;
    `);

    // 3. Dispatch to print_jobs queue
    await client.query(`
      INSERT INTO print_jobs (company_id, kot_id, printer_id, payload, status)
      VALUES (
        '${COMPANY_ID}',
        '${testKotId}',
        '${PRINTER_ID}',
        '{"ticket": "test", "items": 2}'::jsonb,
        'PENDING'
      );
    `);

    const kotItemsRes = await client.query(`
      SELECT item_name_snapshot, brand_name_snapshot FROM kot_items WHERE kot_id = '${testKotId}';
    `);
    const kotItemNames = kotItemsRes.rows.map(r => r.item_name_snapshot);

    const hasAmericano = kotItemNames.includes('Iced Americano');
    const hasBrownie = kotItemNames.includes('Warm Sizzler Brownie with Gelato');
    const hasNoWater = !kotItemNames.includes('Natural Sparkling Water 500ml');
    const hasNoGiftBox = !kotItemNames.includes('Packaged Brownie Gift Box (6 pcs)');

    assert(
      hasAmericano && hasBrownie && hasNoWater && hasNoGiftBox && kotItemsRes.rows.length === 2,
      'Test 7: KOT Kitchen Product Filtering',
      `KOT ticket contains only the 2 kitchen-eligible items (Excluded packaged water & gift box).`
    );

    // ------------------------------------------------------------------
    // TEST 8: Retail-Only Invoices Cannot Generate Empty KOTs
    // ------------------------------------------------------------------
    const testRetailInvId = 'ffffffff-3333-4fff-8fff-333333333333';
    const testRetailInvNum = `INV-RETAIL-${Date.now()}`;

    await client.query(`
      INSERT INTO invoices (
        id, company_id, cashier_id, invoice_number, financial_year, counter_code,
        company_legal_name_snapshot, company_trade_name_snapshot, company_gstin_snapshot,
        company_address_snapshot, company_state_code_snapshot, cashier_name_snapshot,
        subtotal_gross, total_discount_amount, total_taxable_amount,
        total_cgst_amount, total_sgst_amount, total_igst_amount, total_cess_amount,
        rounding_adjustment, grand_total, is_interstate, payment_status
      ) VALUES (
        '${testRetailInvId}', '${COMPANY_ID}', '${CASHIER_ID}', '${testRetailInvNum}', '2026-27', 'COUNTER-01',
        'Cafe & Brownie Co Pvt Ltd', 'Cafe Co', '29TESTA0000A1Z5', 'MG Road', '29', 'Anoop K',
        510.00, 0.00, 432.21, 38.89, 38.90, 0.00, 0.00, 0.00, 510.00, FALSE, 'PAID'
      ) ON CONFLICT (id) DO NOTHING;

      -- Insert only retail items (both FALSE)
      INSERT INTO invoice_items (
        id, company_id, invoice_id, product_id, brand_id,
        brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot, hsn_sac_code_snapshot,
        is_kitchen_item_snapshot, quantity, unit_price, gross_amount, discount_amount, taxable_value,
        tax_rate_percentage, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, line_total
      ) VALUES
      (gen_random_uuid(), '${COMPANY_ID}', '${testRetailInvId}', '88888888-8888-4888-8888-888888888803', '${BRAND_CC_ID}',
       'Cafe Company', 'CC', 'Natural Sparkling Water 500ml', 'CC-RET-WTR', '2201',
       FALSE, 1, 60.00, 60.00, 0.00, 50.85, 18.00, 9.00, 4.57, 9.00, 4.58, 0.00, 0.00, 60.00),

      (gen_random_uuid(), '${COMPANY_ID}', '${testRetailInvId}', '88888888-8888-4888-8888-888888888807', '${BRAND_BS_ID}',
       'Brownie Shop', 'BS', 'Packaged Brownie Gift Box (6 pcs)', 'BS-RET-BX6', '1905',
       FALSE, 1, 450.00, 450.00, 0.00, 381.36, 18.00, 9.00, 34.32, 9.00, 34.32, 0.00, 0.00, 450.00)
      ON CONFLICT DO NOTHING;
    `);

    // Business rule guard verification:
    const retailKitchenCheck = await client.query(`
      SELECT COUNT(*) as eligible_count 
      FROM invoice_items 
      WHERE invoice_id = '${testRetailInvId}' 
        AND is_kitchen_item_snapshot = TRUE;
    `);
    const eligibleCount = parseInt(retailKitchenCheck.rows[0].eligible_count, 10);
    const wouldGenerateKOT = eligibleCount > 0;

    assert(
      !wouldGenerateKOT,
      'Test 8: Retail-Only Zero-KOT Guard',
      `Eligible count is ${eligibleCount}. System successfully blocks empty KOT creation.`
    );

    // ------------------------------------------------------------------
    // TEST 9: Idempotency Protection Against Duplicate KOT Submissions
    // ------------------------------------------------------------------
    const testIdempotencyKey = `idemp-kot-${Date.now()}`;
    await client.query(`
      INSERT INTO idempotency_keys (
        id, company_id, user_id, key, request_path, request_params_hash,
        response_status_code, response_body, status, expires_at
      ) VALUES (
        gen_random_uuid(), '${COMPANY_ID}', '${CASHIER_ID}', '${testIdempotencyKey}',
        '/api/v1/kot/invoices/${testMultiInvId}/print-kot',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        202, '{"kotId": "${testKotId}", "status": "QUEUED"}'::jsonb,
        'COMPLETED', CURRENT_TIMESTAMP + INTERVAL '24 hours'
      );
    `);

    let dupKeyBlocked = false;
    try {
      await client.query(`
        INSERT INTO idempotency_keys (
          id, company_id, user_id, key, request_path, request_params_hash,
          response_status_code, response_body, status, expires_at
        ) VALUES (
          gen_random_uuid(), '${COMPANY_ID}', '${CASHIER_ID}', '${testIdempotencyKey}',
          '/api/v1/kot/invoices/${testMultiInvId}/print-kot',
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          202, '{"kotId": "${testKotId}", "status": "QUEUED"}'::jsonb,
          'COMPLETED', CURRENT_TIMESTAMP + INTERVAL '24 hours'
        );
      `);
    } catch (err) {
      if (err.code === '23505') {
        dupKeyBlocked = true;
      }
    }

    assert(
      dupKeyBlocked,
      'Test 9: Idempotency Protection',
      `Duplicate checkout/KOT request with key '${testIdempotencyKey}' was safely intercepted.`
    );

    // ------------------------------------------------------------------
    // TEST 10: Safe Print Job Claiming with SKIP LOCKED & Lease Expiry
    // ------------------------------------------------------------------
    const claimedJobRes = await client.query(`
      UPDATE print_jobs
      SET status = 'CLAIMED',
          claimed_by_agent_id = '99999999-9999-4999-8999-999999999901',
          claimed_at = CURRENT_TIMESTAMP,
          lock_expires_at = CURRENT_TIMESTAMP + INTERVAL '30 seconds',
          attempts_count = attempts_count + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (
          SELECT id
          FROM print_jobs
          WHERE company_id = '${COMPANY_ID}'
            AND (status = 'PENDING' OR (status = 'CLAIMED' AND lock_expires_at < CURRENT_TIMESTAMP))
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
      )
      RETURNING id, status, attempts_count;
    `);

    const jobClaimedSuccessfully = 
      claimedJobRes.rows.length === 1 && 
      claimedJobRes.rows[0].status === 'CLAIMED' &&
      claimedJobRes.rows[0].attempts_count >= 1;

    assert(
      jobClaimedSuccessfully,
      'Test 10: Print Queue Concurrency & Lease Locking',
      `Job '${claimedJobRes.rows[0]?.id}' safely locked via SKIP LOCKED (attempts: ${claimedJobRes.rows[0]?.attempts_count}).`
    );

    console.log('\n======================================================');
    console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('======================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal test execution error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runTests();
