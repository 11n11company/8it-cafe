-- Seed: 001_initial_dev_seed.sql
-- Description: Development seed data with sample company, brands, roles, tax rates, categories, and products.
-- NOTICE: All GSTINs and tax rates are non-production test configurations.

BEGIN;

-- 1. Sample Legal Company (Single GSTIN Entity)
INSERT INTO companies (
    id, legal_name, trade_name, gstin, pan, phone, email,
    address_line1, address_line2, city, state_name, state_code, pincode, currency_code, is_active
) VALUES (
    '11111111-1111-4111-8111-111111111111',
    'Cafe & Brownie Co Pvt Ltd (Sample Development Entity)',
    'Cafe Company & Brownie Shop',
    '29TESTA0000A1Z5', -- Sample test GSTIN (clearly marked non-production)
    'TESTA0000A',
    '+919876543210',
    'dev-sample@cafecloudpos.internal',
    'Shop 12, Ground Floor, Food Court Promenade',
    'MG Road',
    'Bengaluru',
    'Karnataka',
    '29',
    '560001',
    'INR',
    TRUE
) ON CONFLICT (id) DO NOTHING;

-- 2. Operating Brands under Company
INSERT INTO brands (id, company_id, name, code, description, display_order, is_active) VALUES
(
    '22222222-2222-4222-8222-222222222201',
    '11111111-1111-4111-8111-111111111111',
    'Cafe Company',
    'CC',
    'Artisan coffees, hand-crafted espresso beverages, teas, and cafe savories',
    1,
    TRUE
),
(
    '22222222-2222-4222-8222-222222222202',
    '11111111-1111-4111-8111-111111111111',
    'Brownie Shop',
    'BS',
    'Freshly baked fudge brownies, plated desserts, and artisanal confectioneries',
    2,
    TRUE
) ON CONFLICT (id) DO NOTHING;

-- 3. System Roles
INSERT INTO roles (id, company_id, code, name, description, is_system) VALUES
('33333333-3333-4333-8333-333333333301', '11111111-1111-4111-8111-111111111111', 'ADMIN', 'System Administrator', 'Full administrative access', TRUE),
('33333333-3333-4333-8333-333333333302', '11111111-1111-4111-8111-111111111111', 'STORE_MANAGER', 'Store Manager', 'Operational manager access', TRUE),
('33333333-3333-4333-8333-333333333303', '11111111-1111-4111-8111-111111111111', 'CASHIER', 'Counter Cashier', 'Point of sale billing and manual KOT trigger access', TRUE)
ON CONFLICT (id) DO NOTHING;

-- 4. Permissions
INSERT INTO permissions (id, code, module, description) VALUES
('44444444-4444-4444-8444-444444444401', 'billing.create', 'billing', 'Create carts, complete bills, accept payment'),
('44444444-4444-4444-8444-444444444402', 'billing.calculate', 'billing', 'Request server-side price & tax calculations'),
('44444444-4444-4444-8444-444444444403', 'billing.void', 'billing', 'Void or cancel completed customer invoices'),
('44444444-4444-4444-8444-444444444404', 'kot.print_manual', 'kot', 'Manually trigger kitchen order ticket printing'),
('44444444-4444-4444-8444-444444444405', 'kot.reprint', 'kot', 'Manually reprint a previously issued KOT'),
('44444444-4444-4444-8444-444444444406', 'reports.brand_wise', 'reports', 'View brand-wise revenue breakdown reports'),
('44444444-4444-4444-8444-444444444407', 'reports.consolidated', 'reports', 'View consolidated company-level GST reports')
ON CONFLICT (id) DO NOTHING;

-- Map Cashier Permissions
INSERT INTO role_permissions (role_id, permission_id) VALUES
('33333333-3333-4333-8333-333333333303', '44444444-4444-4444-8444-444444444401'),
('33333333-3333-4333-8333-333333333303', '44444444-4444-4444-8444-444444444402'),
('33333333-3333-4333-8333-333333333303', '44444444-4444-4444-8444-444444444404'),
('33333333-3333-4333-8333-333333333303', '44444444-4444-4444-8444-444444444405')
ON CONFLICT DO NOTHING;

-- 5. Sample Cashier User
INSERT INTO users (
    id, company_id, role_id, username, password_hash, pin_hash, full_name, phone, email, is_active
) VALUES (
    '55555555-5555-4555-8555-555555555501',
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333303',
    'cashier1',
    '$2b$12$e8Z9dDmywOEx5FkmL0Yk9O0vU4E18dZb6rL2T3Xv3.dummyDevHash',
    '$2b$12$K1234dummyPinHash',
    'Anoop Kumar (Sample Cashier)',
    '+919876543211',
    'cashier1@cafecloudpos.internal',
    TRUE
) ON CONFLICT (id) DO NOTHING;

-- 6. Configurable Tax Rates (Marked clearly as test data)
INSERT INTO tax_rates (
    id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active, description
) VALUES
(
    '66666666-6666-4666-8666-666666666601',
    '11111111-1111-4111-8111-111111111111',
    'GST 5% - Restaurant (TEST ONLY)',
    5.00, 2.50, 2.50, 5.00, 0.00, TRUE,
    'TEST DATA: 5% GST split into 2.5% CGST + 2.5% SGST on restaurant items'
),
(
    '66666666-6666-4666-8666-666666666602',
    '11111111-1111-4111-8111-111111111111',
    'GST 18% - Retail Goods (TEST ONLY)',
    18.00, 9.00, 9.00, 18.00, 0.00, TRUE,
    'TEST DATA: 18% GST split into 9% CGST + 9% SGST on packaged confectionery/beverages'
),
(
    '66666666-6666-4666-8666-666666666603',
    '11111111-1111-4111-8111-111111111111',
    'GST 0% - Exempt (TEST ONLY)',
    0.00, 0.00, 0.00, 0.00, 0.00, TRUE,
    'TEST DATA: 0% GST exempt'
) ON CONFLICT (id) DO NOTHING;

-- 7. Categories
INSERT INTO categories (id, company_id, brand_id, name, display_order, is_active) VALUES
-- Cafe Company Categories
('77777777-7777-4777-8777-777777777701', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 'Hot Beverages', 1, TRUE),
('77777777-7777-4777-8777-777777777702', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 'Cold Beverages', 2, TRUE),
('77777777-7777-4777-8777-777777777703', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 'Packaged Retail Drinks & Snacks', 3, TRUE),

-- Brownie Shop Categories
('77777777-7777-4777-8777-777777777704', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222202', 'Plated & Warm Desserts', 1, TRUE),
('77777777-7777-4777-8777-777777777705', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222202', 'Packaged Brownie Gift Boxes & Bars', 2, TRUE)
ON CONFLICT (id) DO NOTHING;

-- 8. Products with Different Kitchen Eligibility Settings
INSERT INTO products (
    id, company_id, brand_id, category_id, tax_rate_id,
    name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active
) VALUES
-- CAFE COMPANY: Kitchen Prepared (is_kitchen_item = TRUE)
(
    '88888888-8888-4888-8888-888888888801',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222201',
    '77777777-7777-4777-8777-777777777702',
    '66666666-6666-4666-8666-666666666601',
    'Iced Americano',
    'CC-ICE-AME',
    '996331',
    180.00,
    TRUE,
    TRUE,  -- Requires kitchen/barista preparation
    TRUE
),
(
    '88888888-8888-4888-8888-888888888802',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222201',
    '77777777-7777-4777-8777-777777777701',
    '66666666-6666-4666-8666-666666666601',
    'Hot Cappuccino',
    'CC-HOT-CAP',
    '996331',
    160.00,
    TRUE,
    TRUE,  -- Requires kitchen/barista preparation
    TRUE
),
-- CAFE COMPANY: Packaged Retail Goods (is_kitchen_item = FALSE)
(
    '88888888-8888-4888-8888-888888888803',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222201',
    '77777777-7777-4777-8777-777777777703',
    '66666666-6666-4666-8666-666666666602',
    'Natural Sparkling Water 500ml',
    'CC-RET-WTR',
    '2201',
    60.00,
    TRUE,
    FALSE, -- Packaged retail bottle, NO kitchen preparation
    TRUE
),
(
    '88888888-8888-4888-8888-888888888804',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222201',
    '77777777-7777-4777-8777-777777777703',
    '66666666-6666-4666-8666-666666666602',
    'Almond Biscotti Retail Pack (100g)',
    'CC-RET-BIS',
    '1905',
    120.00,
    TRUE,
    FALSE, -- Packaged retail pack, NO kitchen preparation
    TRUE
),

-- BROWNIE SHOP: Kitchen Prepared (is_kitchen_item = TRUE)
(
    '88888888-8888-4888-8888-888888888805',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222202',
    '77777777-7777-4777-8777-777777777704',
    '66666666-6666-4666-8666-666666666601',
    'Warm Sizzler Brownie with Gelato',
    'BS-PLT-SIZ',
    '996331',
    220.00,
    TRUE,
    TRUE,  -- Requires kitchen plating & heating
    TRUE
),
(
    '88888888-8888-4888-8888-888888888806',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222202',
    '77777777-7777-4777-8777-777777777704',
    '66666666-6666-4666-8666-666666666601',
    'Classic Hot Fudge Brownie',
    'BS-PLT-FUD',
    '996331',
    150.00,
    TRUE,
    TRUE,  -- Requires kitchen warming
    TRUE
),
-- BROWNIE SHOP: Packaged Retail Goods (is_kitchen_item = FALSE)
(
    '88888888-8888-4888-8888-888888888807',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222202',
    '77777777-7777-4777-8777-777777777705',
    '66666666-6666-4666-8666-666666666602',
    'Packaged Brownie Gift Box (6 pcs)',
    'BS-RET-BX6',
    '1905',
    450.00,
    TRUE,
    FALSE, -- Pre-packaged gift box, NO kitchen preparation
    TRUE
),
(
    '88888888-8888-4888-8888-888888888808',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222202',
    '77777777-7777-4777-8777-777777777705',
    '66666666-6666-4666-8666-666666666602',
    'Artisan Dark Chocolate Bar 100g',
    'BS-RET-BAR',
    '1806',
    180.00,
    TRUE,
    FALSE, -- Packaged retail chocolate bar, NO kitchen preparation
    TRUE
) ON CONFLICT (id) DO NOTHING;

-- 9. Initial Invoice Sequence for FY 2026-27
INSERT INTO invoice_sequences (company_id, financial_year, prefix, current_number)
VALUES ('11111111-1111-4111-8111-111111111111', '2026-27', 'INV', 0)
ON CONFLICT (company_id, financial_year, prefix) DO NOTHING;

-- 10. Local Print Agent and Kitchen Wi-Fi Printer
INSERT INTO print_agents (
    id, company_id, agent_code, agent_name, api_key_hash, is_active
) VALUES (
    '99999999-9999-4999-8999-999999999901',
    '11111111-1111-4111-8111-111111111111',
    'AGENT-STORE-01',
    'Counter 01 Local Print Daemon',
    'sha256$dummyAgentApiKeyHashForDevTestingOnly',
    TRUE
) ON CONFLICT (id) DO NOTHING;

INSERT INTO printers (
    id, company_id, print_agent_id, printer_code, printer_name,
    printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active
) VALUES (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01',
    '11111111-1111-4111-8111-111111111111',
    '99999999-9999-4999-8999-999999999901',
    'KITCHEN-WIFI-01',
    'Kitchen Wi-Fi Thermal Printer (ESC/POS)',
    'KITCHEN_KOT',
    'TCP_IP',
    '192.168.1.150',
    9100,
    80,
    48,
    TRUE
) ON CONFLICT (id) DO NOTHING;

COMMIT;
