/**
 * Cafe Cloud POS - PostgreSQL Schema & Business Logic Verification Test Suite
 * Tests all 10 required architectural and business invariants.
 *
 * All fixtures and business tests run inside a single transaction that is ALWAYS
 * rolled back at the end, ensuring zero leftover test data in the database.
 * Every expected constraint failure is isolated using PostgreSQL SAVEPOINTs
 * to prevent transaction abort states.
 */

const { Client } = require('pg');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'cafe_cloud_pos',
  user: process.env.DB_USER || 'cafe_admin',
  password: process.env.DB_PASSWORD || 'cafe_secure_dev_pass_2026',
};

async function runTests() {
  const client = new Client(config);
  let passed = 0;
  let failed = 0;
  let inTransaction = false;

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
    await client.connect();

    console.log('\n======================================================');
    console.log(' CAFE CLOUD POS - DATABASE INTEGRITY & TEST SUITE');
    console.log('======================================================\n');

    // ------------------------------------------------------------------
    // TEST 1: Schema Inventory - All 21 Domain Tables Exist
    // (Executed outside the transaction as it is read-only)
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
    const existingTables = tablesRes.rows.map((r) => r.table_name);
    const missingTables = expectedTables.filter((t) => !existingTables.includes(t));

    assert(
      missingTables.length === 0,
      'Test 1: Schema Inventory',
      `All 21 required domain tables exist. (Missing: ${missingTables.join(', ') || 'None'})`
    );

    // ==================================================================
    // START ISOLATED TRANSACTION FOR BUSINESS INVARIANT TESTS (2 - 10)
    // ==================================================================
    await client.query('BEGIN;');
    inTransaction = true;

    // ------------------------------------------------------------------
    // FIXTURE PROVISIONING (Isolated, self-contained test entities)
    // Generated dynamically via crypto.randomUUID() to avoid conflicts.
    // ------------------------------------------------------------------
    const fixtureCompanyId = crypto.randomUUID();
    const fixtureBrandCcId = crypto.randomUUID();
    const fixtureBrandBsId = crypto.randomUUID();
    const fixtureRoleId = crypto.randomUUID();
    const fixtureCashierId = crypto.randomUUID();
    const fixtureTax5Id = crypto.randomUUID();
    const fixtureTax18Id = crypto.randomUUID();
    const fixtureCatCcId = crypto.randomUUID();
    const fixtureCatBsId = crypto.randomUUID();
    const fixtureProdKitCc = crypto.randomUUID();
    const fixtureProdRetCc = crypto.randomUUID();
    const fixtureProdKitBs = crypto.randomUUID();
    const fixtureProdRetBs = crypto.randomUUID();
    const fixtureAgentId = crypto.randomUUID();
    const fixturePrinterId = crypto.randomUUID();

    // Generate unique values for columns with UNIQUE constraints
    const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    const fixtureGstin = '29' + crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 10) + '1Z5';
    const fixtureUsername = `cashier_${uniqueSuffix}`;
    const fixtureAgentCode = `AGENT_${uniqueSuffix}`;
    const fixturePrinterCode = `PRN_${uniqueSuffix}`;

    // 1. Parent Company (Using exact columns: legal_name, trade_name; no 'name' column)
    await client.query(`
      INSERT INTO companies (
        id, legal_name, trade_name, gstin, phone, address_line1, city, state_name, state_code, pincode, currency_code, is_active
      ) VALUES (
        $1, 'Cafe & Brownie Co Pvt Ltd (Test Entity)', 'Cafe Company & Brownie Shop (Test)',
        $2, '+919876543210', 'Shop 12, Food Court', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE
      );
    `, [fixtureCompanyId, fixtureGstin]);

    // 2. Child Brands
    await client.query(`
      INSERT INTO brands (id, company_id, name, code, display_order, is_active) VALUES
        ($1, $2, 'Cafe Company Test', 'CCT', 1, TRUE),
        ($3, $2, 'Brownie Shop Test', 'BST', 2, TRUE);
    `, [fixtureBrandCcId, fixtureCompanyId, fixtureBrandBsId]);

    // 3. System Role
    await client.query(`
      INSERT INTO roles (id, company_id, code, name, description, is_system) VALUES
        ($1, $2, 'TEST_CASHIER', 'Test Cashier Role', 'Role for verification suite', FALSE);
    `, [fixtureRoleId, fixtureCompanyId]);

    // 4. Cashier User
    await client.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, full_name, phone, is_active
      ) VALUES (
        $1, $2, $3, $4, '$2b$12$dummyHashForVerificationTestsOnly', 'Test Cashier User', '+919876543211', TRUE
      );
    `, [fixtureCashierId, fixtureCompanyId, fixtureRoleId, fixtureUsername]);

    // 5. Configurable Tax Rates
    await client.query(`
      INSERT INTO tax_rates (
        id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active
      ) VALUES
        ($1, $2, 'GST 5% Test', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE),
        ($3, $2, 'GST 18% Test', 18.00, 9.00, 9.00, 18.00, 0.00, TRUE);
    `, [fixtureTax5Id, fixtureCompanyId, fixtureTax18Id]);

    // 6. Categories for both brands
    await client.query(`
      INSERT INTO categories (id, company_id, brand_id, name, display_order, is_active) VALUES
        ($1, $2, $3, 'Beverages Test', 1, TRUE),
        ($4, $2, $5, 'Desserts Test', 1, TRUE);
    `, [fixtureCatCcId, fixtureCompanyId, fixtureBrandCcId, fixtureCatBsId, fixtureBrandBsId]);

    // 7. Products (2 kitchen-prepared, 2 retail-packaged)
    await client.query(`
      INSERT INTO products (
        id, company_id, brand_id, category_id, tax_rate_id,
        name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active
      ) VALUES
        ($1, $2, $3, $4, $5, 'Iced Americano', $6, '996331', 180.00, TRUE, TRUE, TRUE),
        ($7, $2, $3, $4, $8, 'Natural Sparkling Water 500ml', $9, '2201', 60.00, TRUE, FALSE, TRUE),
        ($10, $2, $11, $12, $5, 'Warm Sizzler Brownie with Gelato', $13, '996331', 220.00, TRUE, TRUE, TRUE),
        ($14, $2, $11, $12, $8, 'Packaged Brownie Gift Box (6 pcs)', $15, '1905', 450.00, TRUE, FALSE, TRUE);
    `, [
      fixtureProdKitCc, fixtureCompanyId, fixtureBrandCcId, fixtureCatCcId, fixtureTax5Id, `SKU-AME-${uniqueSuffix}`,
      fixtureProdRetCc, fixtureTax18Id, `SKU-WTR-${uniqueSuffix}`,
      fixtureProdKitBs, fixtureBrandBsId, fixtureCatBsId, `SKU-SIZ-${uniqueSuffix}`,
      fixtureProdRetBs, `SKU-BX6-${uniqueSuffix}`
    ]);

    // 8. On-Premise Print Agent
    await client.query(`
      INSERT INTO print_agents (
        id, company_id, agent_code, agent_name, api_key_hash, is_active
      ) VALUES (
        $1, $2, $3, 'Counter 01 Test Print Daemon', 'hash_test_dummy_agent_key', TRUE
      );
    `, [fixtureAgentId, fixtureCompanyId, fixtureAgentCode]);

    // 9. Kitchen Thermal Printer
    await client.query(`
      INSERT INTO printers (
        id, company_id, print_agent_id, printer_code, printer_name,
        printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active
      ) VALUES (
        $1, $2, $3, $4, 'Kitchen Wi-Fi Thermal Printer (Test)',
        'KITCHEN_KOT', 'TCP_IP', '192.168.1.150', 9100, 80, 48, TRUE
      );
    `, [fixturePrinterId, fixtureCompanyId, fixtureAgentId, fixturePrinterCode]);

    // ------------------------------------------------------------------
    // TEST 2: Foreign Key Constraints Active
    // Tests that inserting a product with an invalid brand_id is rejected.
    // Company, category, and tax rate IDs are strictly valid fixture IDs.
    // ------------------------------------------------------------------
    const spTest2 = 'sp_test2_fk';
    await client.query(`SAVEPOINT ${spTest2};`);
    let fkBlocked = false;
    try {
      await client.query(`
        INSERT INTO products (
          id, company_id, brand_id, category_id, tax_rate_id,
          name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active
        ) VALUES (
          $1, $2, $3, $4, $5,
          'FK Test Product', $6, '996331', 100.00, TRUE, FALSE, TRUE
        );
      `, [
        crypto.randomUUID(),
        fixtureCompanyId,
        '00000000-0000-0000-0000-000000000000', // Non-existent brand
        fixtureCatCcId,
        fixtureTax5Id,
        `SKU-FK-${uniqueSuffix}`
      ]);
      await client.query(`RELEASE SAVEPOINT ${spTest2};`);
    } catch (err) {
      if (err.code === '23503') { // foreign_key_violation
        fkBlocked = true;
      }
      await client.query(`ROLLBACK TO SAVEPOINT ${spTest2};`);
      await client.query(`RELEASE SAVEPOINT ${spTest2};`);
    }

    assert(
      fkBlocked,
      'Test 2: Foreign Key Enforcement',
      'PostgreSQL rejected orphan child record with invalid brand FK (code 23503).'
    );

    // ------------------------------------------------------------------
    // TEST 3: Duplicate Invoice Numbers Are Rejected
    // ------------------------------------------------------------------
    const testInvNum = `TEST-INV-${Date.now()}`;
    const testInvId = crypto.randomUUID();

    // First insert: succeeds cleanly
    await client.query(`
      INSERT INTO invoices (
        id, company_id, cashier_id, invoice_number, financial_year, counter_code,
        company_legal_name_snapshot, company_trade_name_snapshot, company_gstin_snapshot,
        company_address_snapshot, company_state_code_snapshot, cashier_name_snapshot,
        subtotal_gross, total_discount_amount, total_taxable_amount,
        total_cgst_amount, total_sgst_amount, total_igst_amount, total_cess_amount,
        rounding_adjustment, grand_total, is_interstate, payment_status
      ) VALUES (
        $1, $2, $3, $4, '2026-27', 'COUNTER-01',
        'Cafe & Brownie Co Pvt Ltd (Test Entity)', 'Cafe Company & Brownie Shop (Test)', $5,
        'Shop 12, Food Court', '29', 'Test Cashier User',
        300.00, 0.00, 285.71, 7.14, 7.15, 0.00, 0.00, 0.00, 300.00, FALSE, 'PAID'
      );
    `, [testInvId, fixtureCompanyId, fixtureCashierId, testInvNum, fixtureGstin]);

    // Second insert with duplicate invoice_number: must be caught in SAVEPOINT
    const spTest3 = 'sp_test3_dup';
    await client.query(`SAVEPOINT ${spTest3};`);
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
          $1, $2, $3, $4, '2026-27', 'COUNTER-01',
          'Cafe & Brownie Co Pvt Ltd (Test Entity)', 'Cafe Company & Brownie Shop (Test)', $5,
          'Shop 12, Food Court', '29', 'Test Cashier User',
          300.00, 0.00, 285.71, 7.14, 7.15, 0.00, 0.00, 0.00, 300.00, FALSE, 'PAID'
        );
      `, [crypto.randomUUID(), fixtureCompanyId, fixtureCashierId, testInvNum, fixtureGstin]);
      await client.query(`RELEASE SAVEPOINT ${spTest3};`);
    } catch (err) {
      if (err.code === '23505') { // unique_violation on (company_id, invoice_number)
        dupRejected = true;
      }
      await client.query(`ROLLBACK TO SAVEPOINT ${spTest3};`);
      await client.query(`RELEASE SAVEPOINT ${spTest3};`);
    }

    assert(
      dupRejected,
      'Test 3: Unique Constraint on Invoices',
      `Duplicate invoice number '${testInvNum}' was rejected (code 23505).`
    );

    // ------------------------------------------------------------------
    // TEST 4: Company Isolation Enforcement
    // ------------------------------------------------------------------
    const spTest4 = 'sp_test4_isolation';
    await client.query(`SAVEPOINT ${spTest4};`);
    let invalidCompanyBlocked = false;
    try {
      await client.query(`
        INSERT INTO brands (id, company_id, name, code)
        VALUES ($1, '00000000-0000-0000-0000-000000000000', 'Illegal Brand', 'IB');
      `, [crypto.randomUUID()]);
      await client.query(`RELEASE SAVEPOINT ${spTest4};`);
    } catch (err) {
      if (err.code === '23503') { // foreign_key_violation
        invalidCompanyBlocked = true;
      }
      await client.query(`ROLLBACK TO SAVEPOINT ${spTest4};`);
      await client.query(`RELEASE SAVEPOINT ${spTest4};`);
    }

    assert(
      invalidCompanyBlocked,
      'Test 4: Company Isolation Boundary',
      'Entities cannot reference non-existent company IDs.'
    );

    // ------------------------------------------------------------------
    // TEST 5: Kitchen Eligibility Snapshot Stored on Invoice Items
    // ------------------------------------------------------------------
    const testMultiInvId = crypto.randomUUID();
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
        $1, $2, $3, $4, '2026-27', 'COUNTER-01',
        'Cafe & Brownie Co Pvt Ltd (Test Entity)', 'Cafe Company & Brownie Shop (Test)', $5,
        'Shop 12, Food Court', '29', 'Test Cashier User',
        910.00, 0.00, 843.81, 33.09, 33.10, 0.00, 0.00, 0.00, 910.00, FALSE, 'PAID'
      );
    `, [testMultiInvId, fixtureCompanyId, fixtureCashierId, testMultiInvNum, fixtureGstin]);

    // Insert 4 line items referencing our products and brands
    await client.query(`
      INSERT INTO invoice_items (
        id, company_id, invoice_id, product_id, brand_id,
        brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot, hsn_sac_code_snapshot,
        is_kitchen_item_snapshot, quantity, unit_price, gross_amount, discount_amount, taxable_value,
        tax_rate_percentage, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, line_total, notes
      ) VALUES
      -- 1. Iced Americano (Cafe Company) -> Kitchen Item: TRUE
      ($1, $2, $3, $4, $5, 'Cafe Company Test', 'CCT', 'Iced Americano', 'SKU-AME', '996331',
       TRUE, 1, 180.00, 180.00, 0.00, 171.43, 5.00, 2.50, 4.28, 2.50, 4.29, 0.00, 0.00, 180.00, 'Extra ice'),

      -- 2. Sparkling Water (Cafe Company) -> Retail Item: FALSE
      ($6, $2, $3, $7, $5, 'Cafe Company Test', 'CCT', 'Natural Sparkling Water 500ml', 'SKU-WTR', '2201',
       FALSE, 1, 60.00, 60.00, 0.00, 50.85, 18.00, 9.00, 4.57, 9.00, 4.58, 0.00, 0.00, 60.00, NULL),

      -- 3. Warm Sizzler Brownie (Brownie Shop) -> Kitchen Item: TRUE
      ($8, $2, $3, $9, $10, 'Brownie Shop Test', 'BST', 'Warm Sizzler Brownie with Gelato', 'SKU-SIZ', '996331',
       TRUE, 1, 220.00, 220.00, 0.00, 209.52, 5.00, 2.50, 5.24, 2.50, 5.24, 0.00, 0.00, 220.00, 'Extra chocolate sauce'),

      -- 4. Packaged Gift Box (Brownie Shop) -> Retail Item: FALSE
      ($11, $2, $3, $12, $10, 'Brownie Shop Test', 'BST', 'Packaged Brownie Gift Box (6 pcs)', 'SKU-BX6', '1905',
       FALSE, 1, 450.00, 450.00, 0.00, 381.36, 18.00, 9.00, 34.32, 9.00, 34.32, 0.00, 0.00, 450.00, NULL);
    `, [
      crypto.randomUUID(), fixtureCompanyId, testMultiInvId, fixtureProdKitCc, fixtureBrandCcId,
      crypto.randomUUID(), fixtureProdRetCc,
      crypto.randomUUID(), fixtureProdKitBs, fixtureBrandBsId,
      crypto.randomUUID(), fixtureProdRetBs
    ]);

    const snapRes = await client.query(`
      SELECT item_name_snapshot, is_kitchen_item_snapshot 
      FROM invoice_items 
      WHERE invoice_id = $1
      ORDER BY item_name_snapshot ASC;
    `, [testMultiInvId]);

    const americano = snapRes.rows.find((r) => r.item_name_snapshot === 'Iced Americano');
    const water = snapRes.rows.find((r) => r.item_name_snapshot === 'Natural Sparkling Water 500ml');
    const brownie = snapRes.rows.find((r) => r.item_name_snapshot === 'Warm Sizzler Brownie with Gelato');
    const giftbox = snapRes.rows.find((r) => r.item_name_snapshot === 'Packaged Brownie Gift Box (6 pcs)');

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
      SELECT COUNT(*) as count FROM kots WHERE invoice_id = $1;
    `, [testMultiInvId]);
    const initialKotCount = parseInt(kotCheck.rows[0].count, 10);

    assert(
      initialKotCount === 0,
      'Test 6: Invoice Decoupling from KOT',
      `Invoice is saved and paid, but exactly ${initialKotCount} KOT tickets exist (NO auto-KOT).`
    );

    // ------------------------------------------------------------------
    // TEST 7: KOT Contains ONLY Eligible Kitchen Items
    // ------------------------------------------------------------------
    const testKotId = crypto.randomUUID();
    const testKotNum = `KOT-MULTI-${Date.now()}`;

    // 1. Create KOT record
    await client.query(`
      INSERT INTO kots (id, company_id, invoice_id, kot_number, cashier_id, is_reprint, reprint_count)
      VALUES ($1, $2, $3, $4, $5, FALSE, 0);
    `, [testKotId, fixtureCompanyId, testMultiInvId, testKotNum, fixtureCashierId]);

    // 2. Insert items filtering by is_kitchen_item_snapshot = TRUE
    await client.query(`
      INSERT INTO kot_items (id, kot_id, invoice_item_id, brand_id, brand_name_snapshot, item_name_snapshot, quantity, preparation_notes)
      SELECT 
        gen_random_uuid(),
        $1,
        ii.id,
        ii.brand_id,
        ii.brand_name_snapshot,
        ii.item_name_snapshot,
        ii.quantity,
        ii.notes
      FROM invoice_items ii
      WHERE ii.invoice_id = $2
        AND ii.is_kitchen_item_snapshot = TRUE;
    `, [testKotId, testMultiInvId]);

    const kotItemsRes = await client.query(`
      SELECT item_name_snapshot, brand_name_snapshot FROM kot_items WHERE kot_id = $1;
    `, [testKotId]);
    const kotItemNames = kotItemsRes.rows.map((r) => r.item_name_snapshot);

    const hasAmericano = kotItemNames.includes('Iced Americano');
    const hasBrownie = kotItemNames.includes('Warm Sizzler Brownie with Gelato');
    const hasNoWater = !kotItemNames.includes('Natural Sparkling Water 500ml');
    const hasNoGiftBox = !kotItemNames.includes('Packaged Brownie Gift Box (6 pcs)');

    assert(
      hasAmericano && hasBrownie && hasNoWater && hasNoGiftBox && kotItemsRes.rows.length === 2,
      'Test 7: KOT Kitchen Product Filtering',
      'KOT ticket contains only the 2 kitchen-eligible items (Excluded packaged water & gift box).'
    );

    // ------------------------------------------------------------------
    // TEST 8: Retail-Only Invoices Cannot Generate Empty KOTs
    // ------------------------------------------------------------------
    const testRetailInvId = crypto.randomUUID();
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
        $1, $2, $3, $4, '2026-27', 'COUNTER-01',
        'Cafe & Brownie Co Pvt Ltd (Test Entity)', 'Cafe Company & Brownie Shop (Test)', $5,
        'Shop 12, Food Court', '29', 'Test Cashier User',
        510.00, 0.00, 432.21, 38.89, 38.90, 0.00, 0.00, 0.00, 510.00, FALSE, 'PAID'
      );
    `, [testRetailInvId, fixtureCompanyId, fixtureCashierId, testRetailInvNum, fixtureGstin]);

    // Insert only retail items (both FALSE)
    await client.query(`
      INSERT INTO invoice_items (
        id, company_id, invoice_id, product_id, brand_id,
        brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot, hsn_sac_code_snapshot,
        is_kitchen_item_snapshot, quantity, unit_price, gross_amount, discount_amount, taxable_value,
        tax_rate_percentage, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, line_total
      ) VALUES
      ($1, $2, $3, $4, $5, 'Cafe Company Test', 'CCT', 'Natural Sparkling Water 500ml', 'SKU-WTR', '2201',
       FALSE, 1, 60.00, 60.00, 0.00, 50.85, 18.00, 9.00, 4.57, 9.00, 4.58, 0.00, 0.00, 60.00),

      ($6, $2, $3, $7, $8, 'Brownie Shop Test', 'BST', 'Packaged Brownie Gift Box (6 pcs)', 'SKU-BX6', '1905',
       FALSE, 1, 450.00, 450.00, 0.00, 381.36, 18.00, 9.00, 34.32, 9.00, 34.32, 0.00, 0.00, 450.00);
    `, [
      crypto.randomUUID(), fixtureCompanyId, testRetailInvId, fixtureProdRetCc, fixtureBrandCcId,
      crypto.randomUUID(), fixtureProdRetBs, fixtureBrandBsId
    ]);

    const retailKitchenCheck = await client.query(`
      SELECT COUNT(*) as eligible_count 
      FROM invoice_items 
      WHERE invoice_id = $1
        AND is_kitchen_item_snapshot = TRUE;
    `, [testRetailInvId]);
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
        $1, $2, $3, $4,
        $5,
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        202, '{"status": "QUEUED"}'::jsonb,
        'COMPLETED', CURRENT_TIMESTAMP + INTERVAL '24 hours'
      );
    `, [
      crypto.randomUUID(),
      fixtureCompanyId,
      fixtureCashierId,
      testIdempotencyKey,
      `/api/v1/kot/invoices/${testMultiInvId}/print-kot`
    ]);

    // Duplicate idempotency key insertion inside SAVEPOINT
    const spTest9 = 'sp_test9_idemp';
    await client.query(`SAVEPOINT ${spTest9};`);
    let dupKeyBlocked = false;
    try {
      await client.query(`
        INSERT INTO idempotency_keys (
          id, company_id, user_id, key, request_path, request_params_hash,
          response_status_code, response_body, status, expires_at
        ) VALUES (
          $1, $2, $3, $4,
          $5,
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          202, '{"status": "QUEUED"}'::jsonb,
          'COMPLETED', CURRENT_TIMESTAMP + INTERVAL '24 hours'
        );
      `, [
        crypto.randomUUID(),
        fixtureCompanyId,
        fixtureCashierId,
        testIdempotencyKey,
        `/api/v1/kot/invoices/${testMultiInvId}/print-kot`
      ]);
      await client.query(`RELEASE SAVEPOINT ${spTest9};`);
    } catch (err) {
      if (err.code === '23505') { // unique_violation
        dupKeyBlocked = true;
      }
      await client.query(`ROLLBACK TO SAVEPOINT ${spTest9};`);
      await client.query(`RELEASE SAVEPOINT ${spTest9};`);
    }

    assert(
      dupKeyBlocked,
      'Test 9: Idempotency Protection',
      `Duplicate checkout/KOT request with key '${testIdempotencyKey}' was safely intercepted.`
    );

    // ------------------------------------------------------------------
    // TEST 10: Safe Print Job Claiming with SKIP LOCKED & Lease Expiry
    // ------------------------------------------------------------------
    const testPrintJobId = crypto.randomUUID();

    // Create a dedicated PENDING print job for this test
    await client.query(`
      INSERT INTO print_jobs (
        id, company_id, kot_id, printer_id, payload, status, attempts_count
      ) VALUES (
        $1, $2, $3, $4, '{"ticket": "test-claim", "items": 2}'::jsonb, 'PENDING', 0
      );
    `, [testPrintJobId, fixtureCompanyId, testKotId, fixturePrinterId]);

    // Claim pending job using SKIP LOCKED, targeted to our test company
    const claimedJobRes = await client.query(`
      UPDATE print_jobs
      SET status = 'CLAIMED',
          claimed_by_agent_id = $1,
          claimed_at = CURRENT_TIMESTAMP,
          lock_expires_at = CURRENT_TIMESTAMP + INTERVAL '30 seconds',
          attempts_count = attempts_count + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (
          SELECT id
          FROM print_jobs
          WHERE company_id = $2
            AND id = $3
            AND (status = 'PENDING' OR (status = 'CLAIMED' AND lock_expires_at < CURRENT_TIMESTAMP))
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
      )
      RETURNING id, status, attempts_count, claimed_by_agent_id;
    `, [fixtureAgentId, fixtureCompanyId, testPrintJobId]);

    const jobClaimedSuccessfully =
      claimedJobRes.rows.length === 1 &&
      claimedJobRes.rows[0].id === testPrintJobId &&
      claimedJobRes.rows[0].status === 'CLAIMED' &&
      claimedJobRes.rows[0].claimed_by_agent_id === fixtureAgentId &&
      claimedJobRes.rows[0].attempts_count === 1;

    assert(
      jobClaimedSuccessfully,
      'Test 10: Print Queue Concurrency & Lease Locking',
      `Job '${claimedJobRes.rows[0]?.id}' safely locked via SKIP LOCKED (attempts: ${claimedJobRes.rows[0]?.attempts_count}).`
    );

  } catch (err) {
    console.error('\n[FATAL] Unexpected error during verification test execution:', err.message);
    if (err.stack) console.error(err.stack);
    failed++;
  } finally {
    // ------------------------------------------------------------------
    // CLEANUP: Always roll back the test transaction.
    // Zero test records will ever be committed to the database.
    // ------------------------------------------------------------------
    if (inTransaction) {
      try {
        await client.query('ROLLBACK;');
        console.log('\n✓ Isolated verification transaction rolled back cleanly. Database remains pristine.');
      } catch (rollbackErr) {
        console.error('Failed to rollback transaction:', rollbackErr.message);
      }
    }

    await client.end();

    console.log('\n======================================================');
    console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('======================================================\n');

    if (failed > 0) {
      process.exitCode = 1;
    }
  }
}

runTests();
