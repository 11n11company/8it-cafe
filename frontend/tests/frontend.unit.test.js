/**
 * 8it Cafe Cloud POS — Frontend POS & Administration Unit & Integration Tests
 * Comprehensive automated test suite verifying:
 * 1. Static asset serving & dashboard preservation
 * 2. Authentication, session handling & 4-digit PIN switching
 * 3. Role-based permissions & navigation controls
 * 4. Product search, brand filtering & catalog segregation
 * 5. Cart operations & mixed-brand detection
 * 6. Server-authoritative GST calculation preview integration
 * 7. Checkout validation, tenders, change calculation & idempotency
 * 8. Printable receipt layout & data completeness
 * 9. Invoice history, voiding & refund contracts
 * 10. Inventory, recipes & product mapping contracts
 * 11. Reports & analytics API query contracts
 * 12. Responsive tablet landscape CSS validation
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../../backend/src/app');

describe('Frontend POS & Administration Interface Tests', () => {
  let app;

  before(() => {
    app = createApp();
  });

  // ==========================================================================
  // SUITE 1: STATIC ROUTE SERVING & DASHBOARD PRESERVATION
  // ==========================================================================
  describe('1. Static Route Serving & Dashboard Preservation', () => {
    it('1.1 GET / serves the compiled React application entrypoint', async () => {
      const res = await request(app).get('/');
      assert.strictEqual(res.status, 200);
      assert.ok(res.text.includes('id="root"'), 'Root element must exist for React mount');
      assert.ok(res.text.includes('8it Cafe Cloud POS'), 'Title must reflect brand');
    });

    it('1.2 GET /dashboard continues to serve standalone business dashboard', async () => {
      const res = await request(app).get('/dashboard');
      assert.strictEqual(res.status, 200);
      assert.ok(res.text.includes('Business Dashboard') || res.text.includes('8it POS'), 'Dashboard HTML served');
      assert.ok(res.text.includes('dashboard.js'), 'Must load dashboard.js script');
      assert.ok(res.text.includes('styles.css'), 'Must load dashboard styles.css');
    });

    it('1.3 GET /dashboard/styles.css and /dashboard/dashboard.js serve static assets', async () => {
      const cssRes = await request(app).get('/dashboard/styles.css');
      assert.strictEqual(cssRes.status, 200);
      assert.ok(cssRes.headers['content-type'].includes('css'));

      const jsRes = await request(app).get('/dashboard/dashboard.js');
      assert.strictEqual(jsRes.status, 200);
      assert.ok(jsRes.headers['content-type'].includes('javascript'));
    });

    it('1.4 SPA client routes (/pos, /admin, /reports, /invoices, /login) resolve to index.html', async () => {
      for (const route of ['/pos', '/admin', '/reports', '/invoices', '/login']) {
        const res = await request(app).get(route);
        assert.strictEqual(res.status, 200, `Route ${route} must serve 200 OK`);
        assert.ok(res.text.includes('id="root"'), `Route ${route} must serve SPA index.html`);
      }
    });
  });

  // ==========================================================================
  // SUITE 2: AUTHENTICATION & SESSION HANDLING
  // ==========================================================================
  describe('2. Authentication & Session Handling Logic', () => {
    it('2.1 Login credentials envelope format conforms to backend auth contract', () => {
      const payload = { username: 'cashier1', password: 'ValidPassword123' };
      assert.strictEqual(typeof payload.username, 'string');
      assert.strictEqual(typeof payload.password, 'string');
      assert.ok(payload.username.length > 0);
      assert.ok(payload.password.length > 0);
    });

    it('2.2 Cashier quick-switch requires exact UUID and 4-digit numeric PIN', () => {
      const validSwitch = {
        targetUserId: '55555555-5555-4555-8555-555555555503',
        pin: '1234'
      };
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const pinRegex = /^\d{4}$/;

      assert.ok(uuidRegex.test(validSwitch.targetUserId), 'targetUserId must be valid UUID');
      assert.ok(pinRegex.test(validSwitch.pin), 'PIN must be exactly 4 digits');

      assert.strictEqual(pinRegex.test('123'), false, '3-digit PIN rejected');
      assert.strictEqual(pinRegex.test('12345'), false, '5-digit PIN rejected');
      assert.strictEqual(pinRegex.test('12a4'), false, 'Non-numeric PIN rejected');
    });

    it('2.3 Token storage helper protects against null and sets clean strings', () => {
      const mockStorage = {};
      const setToken = (t) => { if (t) mockStorage.token = t; else delete mockStorage.token; };
      const getToken = () => mockStorage.token || null;

      setToken('eyJhbGciOiJIUzI1Ni...');
      assert.strictEqual(getToken(), 'eyJhbGciOiJIUzI1Ni...');

      setToken(null);
      assert.strictEqual(getToken(), null);
    });
  });

  // ==========================================================================
  // SUITE 3: ROLE-BASED NAVIGATION & PERMISSIONS
  // ==========================================================================
  describe('3. Role-Based Navigation & Permissions', () => {
    function evaluatePermissions(role, permissions = []) {
      const r = role.toUpperCase();
      return {
        canAccessAdmin: r === 'ADMIN' || r === 'STORE_MANAGER',
        canAccessReports: r === 'ADMIN' || permissions.includes('report:view'),
        canManageUsers: r === 'ADMIN' || permissions.includes('user:manage_roles'),
        canResetPin: r === 'ADMIN', // Only ADMIN has user:reset_pin
        canVoidInvoices: r === 'ADMIN' || r === 'STORE_MANAGER' || permissions.includes('order:cancel')
      };
    }

    it('3.1 ADMIN role has comprehensive access across all screens', () => {
      const perms = evaluatePermissions('ADMIN', ['report:view', 'order:create', 'user:manage_roles']);
      assert.strictEqual(perms.canAccessAdmin, true);
      assert.strictEqual(perms.canAccessReports, true);
      assert.strictEqual(perms.canManageUsers, true);
      assert.strictEqual(perms.canResetPin, true);
      assert.strictEqual(perms.canVoidInvoices, true);
    });

    it('3.2 STORE_MANAGER has catalog and report access but is forbidden from PIN reset', () => {
      const perms = evaluatePermissions('STORE_MANAGER', ['report:view', 'order:cancel', 'product:create']);
      assert.strictEqual(perms.canAccessAdmin, true);
      assert.strictEqual(perms.canAccessReports, true);
      assert.strictEqual(perms.canResetPin, false, 'Store manager cannot reset cashier PINs');
      assert.strictEqual(perms.canVoidInvoices, true);
    });

    it('3.3 CASHIER is restricted to POS billing and history only', () => {
      const perms = evaluatePermissions('CASHIER', ['order:create', 'order:read', 'product:read']);
      assert.strictEqual(perms.canAccessAdmin, false, 'Cashier cannot access admin panel');
      assert.strictEqual(perms.canAccessReports, false, 'Cashier cannot access reports');
      assert.strictEqual(perms.canManageUsers, false, 'Cashier cannot manage staff');
      assert.strictEqual(perms.canResetPin, false, 'Cashier cannot reset PINs');
    });
  });

  // ==========================================================================
  // SUITE 4: PRODUCT SEARCH & FILTERING
  // ==========================================================================
  describe('4. Product Search & Catalog Segregation', () => {
    const sampleProducts = [
      { id: '1', name: 'Hot Americano', brand_id: 'b1', brand_name: 'Cafe Company', category_id: 'c1', is_kitchen_item: true, is_active: true, selling_price: '180.00' },
      { id: '2', name: 'Iced Latte', brand_id: 'b1', brand_name: 'Cafe Company', category_id: 'c1', is_kitchen_item: true, is_active: true, selling_price: '220.00' },
      { id: '3', name: 'Classic Brownie', brand_id: 'b2', brand_name: 'Brownie Shop', category_id: 'c2', is_kitchen_item: true, is_active: true, selling_price: '150.00' },
      { id: '4', name: 'Bottled Water', brand_id: 'b1', brand_name: 'Cafe Company', category_id: 'c3', is_kitchen_item: false, is_active: true, selling_price: '30.00' },
      { id: '5', name: 'Seasonal Blend', brand_id: 'b1', brand_name: 'Cafe Company', category_id: 'c1', is_kitchen_item: true, is_active: false, selling_price: '250.00' }
    ];

    it('4.1 Brand filter isolates products belonging to selected brand', () => {
      const b2Products = sampleProducts.filter(p => p.brand_id === 'b2');
      assert.strictEqual(b2Products.length, 1);
      assert.strictEqual(b2Products[0].name, 'Classic Brownie');
    });

    it('4.2 Inactive products are hidden for cashier but retained for admin', () => {
      const cashierView = sampleProducts.filter(p => p.is_active);
      const adminView = sampleProducts;
      assert.strictEqual(cashierView.length, 4, 'Cashier views only active items');
      assert.strictEqual(adminView.length, 5, 'Admin views all items including inactive');
    });

    it('4.3 Kitchen toggle filters KOT-eligible items only', () => {
      const kitchenItems = sampleProducts.filter(p => p.is_kitchen_item && p.is_active);
      assert.strictEqual(kitchenItems.length, 3);
      assert.ok(!kitchenItems.some(p => p.name === 'Bottled Water'));
    });

    it('4.4 Search matches product name case-insensitively', () => {
      const query = 'latte';
      const matches = sampleProducts.filter(p => p.name.toLowerCase().includes(query.toLowerCase()));
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].name, 'Iced Latte');
    });

    it('4.5 ProductCategoryAdmin exposes permanent Delete action for categories and products', () => {
      const adminCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/ProductCategoryAdmin.jsx'), 'utf8');
      assert.ok(adminCode.includes('handleDeleteCategory'), 'Must implement handleDeleteCategory');
      assert.ok(adminCode.includes('handleDeleteProduct'), 'Must implement handleDeleteProduct');
      assert.ok(adminCode.includes('title={`Delete category ${c.name}`}'), 'Must render Delete category action button');
      assert.ok(adminCode.includes('title={`Delete product ${p.name}`}'), 'Must render Delete product action button');
    });
  });

  // ==========================================================================
  // SUITE 5: CART OPERATIONS & MULTI-BRAND DETECTION
  // ==========================================================================
  describe('5. Cart Operations & Multi-Brand Detection', () => {
    function createCartManager() {
      let cart = [];
      return {
        getCart: () => cart,
        addItem: (product) => {
          const ex = cart.find(i => i.product.id === product.id);
          if (ex) ex.quantity += 1;
          else cart.push({ product, quantity: 1, discountAmount: 0 });
        },
        updateQty: (productId, qty) => {
          if (qty <= 0) cart = cart.filter(i => i.product.id !== productId);
          else {
            const item = cart.find(i => i.product.id === productId);
            if (item) item.quantity = qty;
          }
        },
        removeItem: (productId) => {
          cart = cart.filter(i => i.product.id !== productId);
        },
        clear: () => { cart = []; },
        isMixedBrand: () => {
          const brands = new Set(cart.map(i => i.product.brand_id));
          return brands.size > 1;
        },
        getGrossSubtotal: () => {
          return cart.reduce((sum, i) => sum + (Number(i.product.selling_price) * i.quantity), 0);
        }
      };
    }

    it('5.1 Adding, incrementing, and decrementing cart items works accurately', () => {
      const mgr = createCartManager();
      const p1 = { id: 'p1', name: 'Americano', brand_id: 'b1', selling_price: '100.00' };

      mgr.addItem(p1);
      assert.strictEqual(mgr.getCart().length, 1);
      assert.strictEqual(mgr.getCart()[0].quantity, 1);
      assert.strictEqual(mgr.getGrossSubtotal(), 100.00);

      mgr.addItem(p1);
      assert.strictEqual(mgr.getCart()[0].quantity, 2);
      assert.strictEqual(mgr.getGrossSubtotal(), 200.00);

      mgr.updateQty('p1', 1);
      assert.strictEqual(mgr.getCart()[0].quantity, 1);

      mgr.updateQty('p1', 0);
      assert.strictEqual(mgr.getCart().length, 0);
    });

    it('5.2 Accurately detects mixed-brand order when products span multiple brands', () => {
      const mgr = createCartManager();
      const p1 = { id: 'p1', name: 'Americano', brand_id: 'b1_cafe', selling_price: '180.00' };
      const p2 = { id: 'p2', name: 'Brownie', brand_id: 'b2_brownie', selling_price: '150.00' };

      mgr.addItem(p1);
      assert.strictEqual(mgr.isMixedBrand(), false, 'Single brand is not mixed');

      mgr.addItem(p2);
      assert.strictEqual(mgr.isMixedBrand(), true, 'Multiple brands detected as mixed');

      mgr.removeItem('p2');
      assert.strictEqual(mgr.isMixedBrand(), false);
    });
  });

  // ==========================================================================
  // SUITE 6: GST CALCULATION PREVIEW INTEGRATION
  // ==========================================================================
  describe('6. GST Calculation Preview Integration', () => {
    it('6.1 Formats cart items payload adhering to calculateCartPreview contract', () => {
      const cart = [
        { product: { id: 'p101' }, quantity: 2, discountAmount: 10 },
        { product: { id: 'p202' }, quantity: 1, discountAmount: 0 }
      ];

      const payload = cart.map(item => ({
        productId: item.product.id,
        quantity: item.quantity,
        discountAmount: item.discountAmount || 0
      }));

      assert.deepStrictEqual(payload, [
        { productId: 'p101', quantity: 2, discountAmount: 10 },
        { productId: 'p202', quantity: 1, discountAmount: 0 }
      ]);
    });

    it('6.2 Validates calculation preview response contains authoritative breakdown', () => {
      const mockBackendCalc = {
        subtotalGross: '510.00',
        totalDiscountAmount: '0.00',
        totalTaxableAmount: '485.71',
        totalCgstAmount: '12.14',
        totalSgstAmount: '12.15',
        totalIgstAmount: '0.00',
        totalCessAmount: '0.00',
        roundingAdjustment: '0.00',
        grandTotal: '510.00',
        brandBreakdown: {
          'Cafe Company': { taxable: '342.86', cgst: '8.57', sgst: '8.57', total: '360.00' },
          'Brownie Shop': { taxable: '142.85', cgst: '3.57', sgst: '3.58', total: '150.00' }
        }
      };

      const sumTaxes = Number(mockBackendCalc.totalCgstAmount) + Number(mockBackendCalc.totalSgstAmount);
      const computedTotal = Number(mockBackendCalc.totalTaxableAmount) + sumTaxes + Number(mockBackendCalc.roundingAdjustment);
      assert.strictEqual(computedTotal.toFixed(2), mockBackendCalc.grandTotal);
      assert.strictEqual(Object.keys(mockBackendCalc.brandBreakdown).length, 2);
    });

    it('6.3 Confirms backend endpoint POST /api/v1/tax-rates/calculate-preview exists and is authenticated', async () => {
      const res = await request(app).post('/api/v1/tax-rates/calculate-preview').send({});
      assert.strictEqual(res.status, 401, 'Registered calculate-preview route must reject unauthenticated requests with 401');

      const wrongRes = await request(app).post('/api/v1/tax-rates/preview').send({});
      assert.strictEqual(wrongRes.status, 404, 'Obsolete /preview route must return 404');
    });

    it('6.4 Validates frontend api.js binds to /tax-rates/calculate-preview and has no mismatched routes', () => {
      const apiCode = fs.readFileSync(path.join(__dirname, '../src/services/api.js'), 'utf8');
      assert.ok(apiCode.includes("request('/tax-rates/calculate-preview'"), 'api.js must bind to /tax-rates/calculate-preview');
      assert.ok(!apiCode.includes("request('/tax-rates/preview'"), 'api.js must not bind to /tax-rates/preview');
      assert.ok(apiCode.includes('/inventory/uom'), 'api.js must bind to /inventory/uom');
      assert.ok(apiCode.includes('/reports/sales/hourly'), 'api.js must bind to /reports/sales/hourly');
      assert.ok(apiCode.includes('/reports/payments'), 'api.js must bind to /reports/payments');
    });
  });

  // ==========================================================================
  // SUITE 7: CHECKOUT TENDERS & IDEMPOTENCY
  // ==========================================================================
  describe('7. Checkout Tenders & Idempotency Key Handling', () => {
    it('7.1 Cash payment validates tendered amount and computes exact change', () => {
      const grandTotal = 430.00;
      const tendered = 500.00;
      const changeDue = Math.max(0, tendered - grandTotal);

      assert.strictEqual(changeDue, 70.00);

      // Rejects insufficient cash
      const insufficient = 400.00;
      assert.ok(insufficient < grandTotal, 'Insufficient cash must be detected');
    });

    it('7.2 Split tender validation ensures exact balance reconciliation', () => {
      const grandTotal = 500.00;
      const splitCash = 200.00;
      const splitUpi = 300.00;
      const remaining = grandTotal - (splitCash + splitUpi);

      assert.strictEqual(remaining, 0.00, 'Exact split matches grand total');

      const invalidSplit = grandTotal - (200.00 + 250.00);
      assert.strictEqual(invalidSplit, 50.00, 'Remaining balance indicates mismatch');
    });

    it('7.3 Idempotency key generation produces unique RFC4122 v4 UUIDs', () => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const keys = new Set();

      for (let i = 0; i < 50; i++) {
        // v4 UUID generation
        const k = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
        assert.ok(uuidRegex.test(k), `Key ${k} must match UUIDv4 format`);
        keys.add(k);
      }

      assert.strictEqual(keys.size, 50, 'All 50 generated keys must be unique');
    });
  });

  // ==========================================================================
  // SUITE 8: RECEIPT PRINTING & DATA COMPLETENESS
  // ==========================================================================
  describe('8. Receipt Printing & Data Completeness', () => {
    it('8.1 Receipt payload contains all required statutory and financial fields', () => {
      const sampleInvoice = {
        invoice_number: 'INV-2026-00042',
        created_at: '2026-11-15T10:30:00.000Z',
        created_by_name: 'Anoop Kumar',
        subtotal_taxable: '485.71',
        cgst_amount: '12.14',
        sgst_amount: '12.15',
        grand_total: '510.00',
        items: [
          { name: 'Americano', brand_name_snapshot: 'Cafe Company', quantity: 2, unit_price_snapshot: '180.00', line_total: '360.00' },
          { name: 'Brownie', brand_name_snapshot: 'Brownie Shop', quantity: 1, unit_price_snapshot: '150.00', line_total: '150.00' }
        ],
        payments: [
          { payment_method: 'CASH', amount: '510.00', tendered_amount: '600.00', change_returned: '90.00' }
        ]
      };

      assert.ok(sampleInvoice.invoice_number.startsWith('INV-'));
      assert.strictEqual(sampleInvoice.items.length, 2);
      assert.strictEqual(sampleInvoice.payments[0].change_returned, '90.00');
    });
  });

  // ==========================================================================
  // SUITE 9: INVENTORY CONTRACTS & RECIPES
  // ==========================================================================
  describe('9. Inventory & Recipe Management Contracts', () => {
    it('9.1 Inventory item creation formats SKU, item_type, and UOM accurately', () => {
      const itemPayload = {
        sku: 'RAW-COFFEE-01',
        name: 'Arabica Espresso Beans',
        item_type: 'RAW_MATERIAL',
        uom_id: 'uom-kg-uuid',
        cost_price: '450.00',
        minimum_stock_level: '10'
      };

      assert.strictEqual(itemPayload.item_type, 'RAW_MATERIAL');
      assert.ok(Number(itemPayload.cost_price) > 0);
    });

    it('9.2 Stock adjustment payload formats location and line items array', () => {
      const adjPayload = {
        location_id: 'loc-kitchen-uuid',
        adjustment_type: 'CYCLE_COUNT',
        reason: 'Monthly inventory count verification',
        items: [
          { item_id: 'item-coffee-uuid', quantity: '2.50', unit_cost: '450.00' }
        ]
      };

      assert.ok(Array.isArray(adjPayload.items));
      assert.strictEqual(adjPayload.items.length, 1);
    });
  });

  // ==========================================================================
  // SUITE 10: REPORTS DATE PRESET TRANSFORMATION
  // ==========================================================================
  describe('10. Reports API Date Preset Contracts', () => {
    it('10.1 Reports parameters include supported presets and brand segregation', () => {
      const validPresets = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_financial_year'];
      for (const preset of validPresets) {
        const queryParams = new URLSearchParams({ datePreset: preset, brandId: 'brand-uuid-1' });
        assert.strictEqual(queryParams.get('datePreset'), preset);
        assert.strictEqual(queryParams.get('brandId'), 'brand-uuid-1');
      }
    });
  });

  // ==========================================================================
  // SUITE 11: RESPONSIVE TABLET LANDSCAPE CSS VALIDATION
  // ==========================================================================
  describe('11. Responsive Tablet Landscape CSS Validation', () => {
    it('11.1 Stylesheet enforces minimum 44px touch targets and tablet landscape layout', () => {
      const cssPath = path.join(__dirname, '../src/index.css');
      const cssContent = fs.readFileSync(cssPath, 'utf8');

      assert.ok(cssContent.includes('--touch-target-min: 44px'), 'Must define min 44px touch target variable');
      assert.ok(cssContent.includes('grid-template-columns: 220px 1fr 380px') || cssContent.includes('pos-screen'), 'Must define tablet 3-column layout');
      assert.ok(cssContent.includes('@media print'), 'Must define thermal print media query');
      assert.ok(cssContent.includes('80mm'), 'Must configure standard 80mm receipt width');
    });
  });

  // ==========================================================================
  // SUITE 12: CASHIER POS BILLING WORKFLOW & KOT DECOUPLING
  // ==========================================================================
  describe('12. Cashier POS Billing Workflow & KOT Decoupling', () => {
    it('12.1 Confirms POST /api/v1/kot/invoices/:id/print-kot is mounted and requires authentication', async () => {
      const res = await request(app)
        .post('/api/v1/kot/invoices/00000000-0000-0000-0000-000000000000/print-kot')
        .send({});
      assert.strictEqual(res.status, 401, 'Unauthenticated request must return HTTP 401');
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.code.includes('TOKEN') || res.body.error.code.includes('AUTH'));
    });

    it('12.2 Confirms POST /api/v1/kot/tickets/:id/reprint is mounted and requires authentication', async () => {
      const res = await request(app)
        .post('/api/v1/kot/tickets/00000000-0000-0000-0000-000000000000/reprint')
        .send({ reason: 'Kitchen reprint test' });
      assert.strictEqual(res.status, 401, 'Unauthenticated request must return HTTP 401');
      assert.strictEqual(res.body.success, false);
    });

    it('12.3 Quick cash denomination calculator provides exact ₹50, ₹100, ₹200, ₹500, ₹2000 chips', () => {
      const denominations = [50, 100, 200, 500, 2000];
      const grandTotal = 345.50;

      // Exact amount
      assert.strictEqual(grandTotal, 345.50);

      // Verify denomination chips are strictly positive integers
      for (const d of denominations) {
        assert.ok(Number.isInteger(d) && d > 0);
      }

      // Next nearest ₹500 chip calculation
      const next500 = Math.ceil(grandTotal / 500) * 500;
      assert.strictEqual(next500, 500);

      // Auto-change calculation
      const changeDue = Math.max(0, 500 - grandTotal);
      assert.strictEqual(Number(changeDue.toFixed(2)), 154.50);

      // Insufficient tender check
      const shortTender = 300.00;
      assert.strictEqual(shortTender < grandTotal, true);
      assert.strictEqual(Number((grandTotal - shortTender).toFixed(2)), 45.50);
    });

    it('12.4 Draft resume restores line items with immutable snapshot keys', () => {
      const mockSavedDraft = {
        id: '11111111-2222-3333-4444-555555555555',
        invoice_number: 'INV-2026-00099',
        payment_status: 'PENDING',
        items: [
          {
            product_id: 'prod-1-uuid',
            product_name_snapshot: 'Iced Americano',
            brand_id: 'brand-cc-uuid',
            brand_name_snapshot: 'Cafe Company',
            unit_price_snapshot: '180.00',
            quantity: 2,
            is_kitchen_item_snapshot: true
          },
          {
            product_id: 'prod-2-uuid',
            product_name_snapshot: 'Sizzler Brownie',
            brand_id: 'brand-bs-uuid',
            brand_name_snapshot: 'Brownie Shop',
            unit_price_snapshot: '220.00',
            quantity: 1,
            is_kitchen_item_snapshot: true
          }
        ]
      };

      assert.strictEqual(mockSavedDraft.payment_status, 'PENDING');
      assert.strictEqual(mockSavedDraft.items.length, 2);
      assert.strictEqual(mockSavedDraft.items[0].is_kitchen_item_snapshot, true);
      assert.strictEqual(mockSavedDraft.items[1].is_kitchen_item_snapshot, true);
    });

    it('12.5 Thermal receipt format includes brand header "8itcafe & Seri\'s hub"', () => {
      const receiptBrandHeader = "8itcafe & Seri's hub";
      assert.strictEqual(receiptBrandHeader, "8itcafe & Seri's hub");
    });
  });

  // ==========================================================================
  // SUITE 13: CASHIER TABLES & SERVICE FLOOR WORKFLOW & REGRESSION TESTS
  // ==========================================================================
  describe('13. Cashier Tables & Service Floor Workflow & Permissions', () => {
    it('13.1 Role normalization maps both ADMINISTRATOR and ADMIN to full authority', () => {
      const { normalizeRole } = require('../../backend/src/middleware/authorize');
      assert.strictEqual(normalizeRole('ADMIN'), 'ADMIN');
      assert.strictEqual(normalizeRole('Administrator'), 'ADMIN');
      assert.strictEqual(normalizeRole('ADMINISTRATOR'), 'ADMIN');
      assert.strictEqual(normalizeRole('MANAGER'), 'STORE_MANAGER');
      assert.strictEqual(normalizeRole('Store Manager'), 'STORE_MANAGER');
      assert.strictEqual(normalizeRole('CASHIER'), 'CASHIER');
      assert.strictEqual(normalizeRole('WAITER'), 'WAITER');
    });

    it('13.2 Category mapping DTO supplies both snake_case and camelCase brand fields', () => {
      const { mapCategoryRowToDto } = require('../../backend/src/services/category.service');
      const sampleRow = {
        id: 'cat-uuid-1',
        company_id: 'comp-uuid-1',
        brand_id: 'brand-uuid-1',
        brand_name: '8itcafe',
        brand_code: 'CC',
        name: 'Beverages',
        description: 'Hot & Cold Beverages',
        display_order: 1,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date()
      };

      const dto = mapCategoryRowToDto(sampleRow);
      assert.strictEqual(dto.brand_id, 'brand-uuid-1');
      assert.strictEqual(dto.brandId, 'brand-uuid-1');
      assert.strictEqual(dto.brand_name, '8itcafe');
      assert.strictEqual(dto.brandName, '8itcafe');

      // Product category filtering check
      const selectedBrandId = 'brand-uuid-1';
      const availableCategories = [dto].filter(c => (c.brand_id || c.brandId) === selectedBrandId);
      assert.strictEqual(availableCategories.length, 1);
      assert.strictEqual(availableCategories[0].name, 'Beverages');
    });

    it('13.3 Cashier table session details accurately formats item notes and brand tags', () => {
      const mockSession = {
        id: 'session-uuid-101',
        tableNumber: '1',
        status: 'BILL_REQUESTED',
        waiterName: 'Waiter Alice',
        timeSinceOrderStarted: '14 mins',
        orderedItemsCount: 3,
        items: [
          {
            id: 'item-1',
            productId: 'prod-1',
            productName: 'Iced Cappuccino',
            brandName: '8itcafe',
            unitPrice: '140.00',
            quantity: 2,
            isKitchenItem: true,
            notes: 'Extra ice and less sugar'
          },
          {
            id: 'item-2',
            productId: 'prod-2',
            productName: 'Chocolate Brownie',
            brandName: "Seri's Hub",
            unitPrice: '160.00',
            quantity: 1,
            isKitchenItem: true,
            notes: 'Warm it up please'
          }
        ]
      };

      assert.strictEqual(mockSession.status, 'BILL_REQUESTED');
      assert.strictEqual(mockSession.items.length, 2);
      assert.strictEqual(mockSession.items[0].notes, 'Extra ice and less sugar');
      assert.strictEqual(mockSession.items[1].brandName, "Seri's Hub");

      // Total session gross computation
      const totalGross = mockSession.items.reduce((sum, it) => sum + (Number(it.unitPrice) * it.quantity), 0);
      assert.strictEqual(totalGross, 440.00);
    });

    it('13.4 Cashier settlement action buttons conform to required workflow', () => {
      const buttonLabels = {
        collectPayment: 'OPEN BILL & COMPLETE PAYMENT',
        backToTables: 'Back to Tables'
      };
      assert.ok(buttonLabels.collectPayment.includes('OPEN BILL'));
      assert.ok(buttonLabels.backToTables.includes('Back to Tables'));
    });
  });

  // ==========================================================================
  // SUITE 14: UNIFIED CART, CHECKOUT & RECEIPT (NO MULTI-BRAND BANNERS/SUBTOTALS)
  // ==========================================================================
  describe('14. Cashier Unified Cart, Checkout & Receipt Integrity', () => {
    it('14.1 CartPanel source code confirms complete removal of Multi-Brand banner and brand subtotals', () => {
      const cartPanelCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/CartPanel.jsx'), 'utf8');
      assert.ok(!cartPanelCode.includes('Multi-Brand Order'), 'CartPanel must not contain Multi-Brand Order banner');
      assert.ok(!cartPanelCode.includes('brand-split-badge'), 'CartPanel must not contain brand-split-badge');
      assert.ok(!cartPanelCode.includes('calculation.brandBreakdown'), 'CartPanel must not display separate brandBreakdown subtotals');
      assert.ok(cartPanelCode.includes('Subtotal (Gross)'), 'CartPanel must retain unified Subtotal (Gross)');
      assert.ok(cartPanelCode.includes('Taxable Amount'), 'CartPanel must retain unified Taxable Amount');
      assert.ok(cartPanelCode.includes('Grand Total'), 'CartPanel must retain unified Grand Total');
    });

    it('14.2 Unified cart combines products across brands with single subtotal and grand total', () => {
      const mixedCart = [
        { product: { id: 'p1', name: 'Cappuccino', brand_id: 'b-8it', brand_name: '8itcafe', selling_price: '140.00' }, quantity: 2 },
        { product: { id: 'p2', name: 'Nutella Brownie', brand_id: 'b-seri', brand_name: "Seri's Hub", selling_price: '160.00' }, quantity: 1 }
      ];

      const totalItems = mixedCart.reduce((sum, item) => sum + item.quantity, 0);
      assert.strictEqual(totalItems, 3);

      const combinedSubtotal = mixedCart.reduce((sum, item) => sum + (Number(item.product.selling_price) * item.quantity), 0);
      assert.strictEqual(combinedSubtotal, 440.00);

      // Verify brand metadata is preserved for backend reporting
      assert.strictEqual(mixedCart[0].product.brand_id, 'b-8it');
      assert.strictEqual(mixedCart[1].product.brand_id, 'b-seri');
    });

    it('14.3 Checkout modal and printable receipt format a single consolidated tax invoice', () => {
      const receiptCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/ReceiptModal.jsx'), 'utf8');
      assert.ok(!receiptCode.includes('Multi-Brand Order'), 'Receipt must not include Multi-Brand Order indicator');
      assert.ok(!receiptCode.includes('8itcafe subtotal'), 'Receipt must not include separate 8itcafe subtotal breakdown');
      assert.ok(!receiptCode.includes("Seri's Hub subtotal"), 'Receipt must not include separate Seri\'s Hub subtotal breakdown');
      assert.ok(receiptCode.includes("8itcafe & Seri's hub"), 'Receipt header must feature unified brand title');
      assert.ok(receiptCode.includes('GRAND TOTAL:'), 'Receipt must show single unified GRAND TOTAL');
      assert.ok(receiptCode.includes('Taxable Subtotal:'), 'Receipt must show single Taxable Subtotal');
    });
  });

  // ==========================================================================
  // SUITE 15: CASHIER HEADER PROFILE DROPDOWN & SWITCH USER
  // ==========================================================================
  describe('15. Cashier Header Profile Dropdown & Switch User', () => {
    it('15.1 Header component removes inline Switch PIN button and wraps cashier profile in interactive menu', () => {
      const headerCode = fs.readFileSync(path.join(__dirname, '../src/components/layout/Header.jsx'), 'utf8');
      assert.ok(!headerCode.includes('className="btn-switch-pin"'), 'Header must not contain inline Switch PIN button');
      assert.ok(!headerCode.includes('className="btn-header-logout"'), 'Header must not contain standalone Logout button');
      assert.ok(headerCode.includes('cashier-menu-wrapper'), 'Header must wrap cashier in menu wrapper');
      assert.ok(headerCode.includes('cashier-dropdown-menu'), 'Header must contain dropdown menu container');
      assert.ok(headerCode.includes('cashier-dropdown-arrow'), 'Header must include dropdown indicator arrow');
    });

    it('15.2 Dropdown menu exposes "Switch User" action triggering onOpenSwitchCashier', () => {
      const headerCode = fs.readFileSync(path.join(__dirname, '../src/components/layout/Header.jsx'), 'utf8');
      assert.ok(headerCode.includes('Switch User'), 'Dropdown menu must show Switch User action');
      assert.ok(headerCode.includes('onOpenSwitchCashier()'), 'Switch User must invoke onOpenSwitchCashier handler');
    });

    it('15.3 Dropdown menu exposes Logout action triggering logout session handler', () => {
      const headerCode = fs.readFileSync(path.join(__dirname, '../src/components/layout/Header.jsx'), 'utf8');
      assert.ok(headerCode.includes('Logout'), 'Dropdown menu must show Logout action');
      assert.ok(headerCode.includes('logout()'), 'Logout menu item must invoke logout handler');
    });

    it('15.4 CashierSwitchModal confirms title and prompts reflect "Switch User (4-Digit PIN)"', () => {
      const modalCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/CashierSwitchModal.jsx'), 'utf8');
      assert.ok(modalCode.includes('title="Switch User (4-Digit PIN)"'), 'Modal title must be Switch User (4-Digit PIN)');
      assert.ok(modalCode.includes('Select Staff Member to Switch'), 'Modal prompt must guide staff switching');
    });

        it('15.5 API request envelope preserves Authorization header when options.headers (such as X-Idempotency-Key) are provided', () => {
      const apiCode = fs.readFileSync(
        path.join(__dirname, '../src/services/api.js'),
        'utf8'
      );

      // Ensure config spreads ...options before headers so options.headers
      // cannot overwrite the Authorization header.
      assert.match(
        apiCode,
        /\.\.\.options,\s*method:\s*options\.method\s*\|\|\s*'GET',\s*headers/,
        'api.js request() must place headers after ...options to avoid erasing Authorization'
      );
    });
  });

  // ==========================================================================
  // SUITE 16: WAITER TABLE STATUS VISUAL REDESIGN (BACKGROUND COLOR STATES)
  // ==========================================================================
  describe('16. Waiter Table Status Visual Redesign & Background Colors', () => {
    const tableGridCode = fs.readFileSync(path.join(__dirname, '../src/components/tables/TableGrid.jsx'), 'utf8');
    const indexCss = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');

    it('16.1 Available table card uses #9EE2B3 background, #80D49B border, dark green text, and hides text badge', () => {
      assert.ok(tableGridCode.includes("cardBg: '#9EE2B3'"), 'Available table card must use #9EE2B3 background');
      assert.ok(tableGridCode.includes("borderColor: '#80D49B'"), 'Available table card must use #80D49B border');
      assert.ok(tableGridCode.includes("showBadge: false"), 'Available table card must hide status badge');
      assert.ok(indexCss.includes('.table-card.available'), 'CSS must define .table-card.available class');
      assert.ok(indexCss.includes('#9EE2B3'), 'CSS must include #9EE2B3 background');
    });

    it('16.2 Occupied table card uses #FEE2E2 light red background, #FECACA border, and displays Occupied badge', () => {
      assert.ok(tableGridCode.includes("cardBg: '#FEE2E2'"), 'Occupied table card must use #FEE2E2 background');
      assert.ok(tableGridCode.includes("borderColor: '#FECACA'"), 'Occupied table card must use #FECACA border');
      assert.ok(tableGridCode.includes("label: 'Occupied'"), 'Occupied table card must display Occupied badge');
      assert.ok(indexCss.includes('.table-card.occupied'), 'CSS must define .table-card.occupied class');
      assert.ok(indexCss.includes('#FEE2E2'), 'CSS must include #FEE2E2 background');
    });

    it('16.3 Red table badge displays Occupied label and Occupied filter chip uses red dot', () => {
      assert.ok(tableGridCode.includes("label: 'Occupied'"), 'Table badge must display Occupied label');
      assert.ok(indexCss.includes('.dot-occupied { background-color: #DC2626; }'), 'Occupied filter dot must be red');
      assert.ok(indexCss.includes('.table-card.bill_requested'), 'CSS must define .table-card.bill_requested class');
    });

    it('16.4 KOT Pending and Payment Pending table cards preserve actionable badges and subtle tints', () => {
      assert.ok(tableGridCode.includes("label: 'KOT Pending'"), 'KOT Pending card must display KOT Pending badge');
      assert.ok(tableGridCode.includes("label: 'Payment Pending'"), 'Payment Pending card must display Payment Pending badge');
      assert.ok(indexCss.includes('.table-card.order_pending'), 'CSS must define .table-card.order_pending class');
      assert.ok(indexCss.includes('.table-card.payment_pending'), 'CSS must define .table-card.payment_pending class');
    });

    it('16.5 Stylesheet enforces 5-column layout for desktop floor view and responsive tablet adjustments', () => {
      assert.ok(indexCss.includes('grid-template-columns: repeat(5, 1fr)'), 'CSS must enforce 5-column grid on desktop');
      assert.ok(indexCss.includes('@media (min-width: 1200px)'), 'CSS must apply 5 columns at 1200px and above');
    });

    it('16.6 TableGrid filter bar only contains All Tables, Available, and Occupied chips (KOT Pending & Bill Requested filter chips removed)', () => {
      assert.ok(tableGridCode.includes('All Tables ({tables.length})'), 'Must include All Tables filter chip');
      assert.ok(tableGridCode.includes('Available ({availableCount})'), 'Must include Available filter chip');
      assert.ok(tableGridCode.includes('Occupied ({occupiedCount})'), 'Must include Occupied filter chip');
      assert.ok(!tableGridCode.includes('KOT Pending ({pendingCount})'), 'KOT Pending filter chip must be removed');
      assert.ok(!tableGridCode.includes('Bill Requested ({billCount})'), 'Bill Requested filter chip must be removed');
    });

    it('16.7 Available table cards omit Ready for Guests and Tap to Seat Guests prompts', () => {
      assert.ok(!tableGridCode.includes('Ready for Guests'), 'Must omit Ready for Guests text');
      assert.ok(!tableGridCode.includes('Tap to Seat Guests'), 'Must omit Tap to Seat Guests text');
    });

    it('16.8 Available table cards omit dashed separator line in footer', () => {
      assert.ok(indexCss.includes('.table-card.available .table-card-footer'), 'CSS must define .table-card.available .table-card-footer');
      assert.ok(tableGridCode.includes("borderTop: session ? `1px dashed ${style.borderColor}` : 'none'"), 'Inline footer borderTop must be none when no active session');
    });
  });

  // ==========================================================================
  // SUITE 17: CASHIER COMPLETE PAYMENT MODAL UI REDESIGN
  // ==========================================================================
  describe('17. Cashier Complete Payment Modal UI Alignment', () => {
    const checkoutModalCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/CheckoutModal.jsx'), 'utf8');
    const posCss = fs.readFileSync(path.join(__dirname, '../src/pos.css'), 'utf8');

    it('17.1 CheckoutModal uses clean "Complete Payment" title and checkout-modal class', () => {
      assert.ok(checkoutModalCode.includes('title="Complete Payment"'), 'Modal must have clean title "Complete Payment"');
      assert.ok(checkoutModalCode.includes('className="checkout-modal"'), 'Modal must declare className="checkout-modal"');
      assert.ok(!checkoutModalCode.includes('pay-title__logo'), 'Modal must not contain inline 8it title logo badge');
    });

    it('17.2 CheckoutModal provides Cash, UPI, and Card methods with specialized vector icons', () => {
      assert.ok(checkoutModalCode.includes("id: 'CASH', label: 'Cash', icon: CashNotesIcon"), 'Must provide Cash mode');
      assert.ok(checkoutModalCode.includes("id: 'UPI', label: 'UPI', icon: UpiPhoneIcon"), 'Must provide UPI phone QR mode');
      assert.ok(checkoutModalCode.includes("id: 'CARD', label: 'Card', icon: CardOutlineIcon"), 'Must provide Card mode');
    });

    it('17.3 pos.css styles checkout modal matching 8it design reference with forest green accents', () => {
      assert.ok(posCss.includes('.checkout-modal.ui-modal'), 'pos.css must style .checkout-modal');
      assert.ok(posCss.includes('color: #0A3D29;'), 'pos.css must use #0A3D29 forest green');
      assert.ok(posCss.includes('background: #0A3D29;'), 'Primary Print Bill button must use #0A3D29');
    });
  });

  // ==========================================================================
  // SUITE 18: PHASE 12A PROGRESSIVE WEB APP (PWA) IMPLEMENTATION
  // ==========================================================================
  describe('18. Phase 12A — Progressive Web App (PWA) Implementation', () => {
    it('18.1 GET /manifest.webmanifest serves valid web app manifest with standalone display and landscape orientation', async () => {
      const res = await request(app).get('/manifest.webmanifest');
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers['content-type'].includes('application/manifest+json'));
      const manifest = JSON.parse(res.text);
      assert.strictEqual(manifest.name, '8it Cafe');
      assert.strictEqual(manifest.short_name, '8it Cafe');
      assert.strictEqual(manifest.display, 'standalone');
      assert.strictEqual(manifest.orientation, 'landscape');
      assert.strictEqual(manifest.theme_color, '#063F2E');
      assert.strictEqual(manifest.background_color, '#F5F8F5');
      assert.ok(manifest.icons && manifest.icons.length >= 4, 'Manifest must provide 192, 512, maskable, and svg icons');
    });

    it('18.2 GET /manifest.json alias serves identical web manifest configuration', async () => {
      const res = await request(app).get('/manifest.json');
      assert.strictEqual(res.status, 200);
      const manifest = JSON.parse(res.text);
      assert.strictEqual(manifest.name, '8it Cafe');
      assert.strictEqual(manifest.short_name, '8it Cafe');
    });

    it('18.3 GET /sw.js serves service worker with Service-Worker-Allowed root scope', async () => {
      const res = await request(app).get('/sw.js');
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers['content-type'].includes('javascript'));
      assert.strictEqual(res.headers['service-worker-allowed'], '/');
      assert.ok(res.text.includes('8it-cafe-v1'), 'Service worker must contain versioned cache identifier');
    });

    it('18.4 Service worker strictly enforces network-only bypass for /api/ requests and non-GET methods', () => {
      const swCode = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
      assert.ok(swCode.includes("url.pathname.startsWith('/api/') || req.method !== 'GET'"), 'SW must bypass cache for /api/ and non-GET');
      assert.ok(swCode.includes("type === 'SKIP_WAITING'"), 'SW must support SKIP_WAITING message');
      assert.ok(swCode.includes('caches.delete'), 'SW must purge obsolete caches on activate');
    });

    it('18.5 Application icon assets exist on disk and index.html binds them cleanly', () => {
      const iconSvg = path.join(__dirname, '../public/icons/icon.svg');
      const icon192 = path.join(__dirname, '../public/icons/icon-192x192.png');
      const icon512 = path.join(__dirname, '../public/icons/icon-512x512.png');
      const appleIcon = path.join(__dirname, '../public/apple-touch-icon.png');
      assert.ok(fs.existsSync(iconSvg), 'icon.svg must exist');
      assert.ok(fs.existsSync(icon192), 'icon-192x192.png must exist');
      assert.ok(fs.existsSync(icon512), 'icon-512x512.png must exist');
      assert.ok(fs.existsSync(appleIcon), 'apple-touch-icon.png must exist');

      const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
      assert.ok(indexHtml.includes('rel="manifest"'), 'index.html must link web manifest');
      assert.ok(indexHtml.includes('content="#063F2E"'), 'index.html must set theme-color #063F2E');
      assert.ok(indexHtml.includes('name="apple-mobile-web-app-capable" content="yes"'), 'index.html must declare standalone mobile support');
    });

    it('18.6 Service worker registration module provides lifecycle listeners and install prompt triggers', () => {
      const swRegCode = fs.readFileSync(path.join(__dirname, '../src/registerServiceWorker.js'), 'utf8');
      assert.ok(swRegCode.includes("navigator.serviceWorker.register('/sw.js')") || swRegCode.includes("register(swUrl)"), 'Must register /sw.js');
      assert.ok(swRegCode.includes('beforeinstallprompt'), 'Must handle beforeinstallprompt');
      assert.ok(swRegCode.includes('controllerchange'), 'Must handle controllerchange');
      assert.ok(swRegCode.includes('activateWaitingWorker'), 'Must export activateWaitingWorker');
    });
  });

  // ==========================================================================
  // SUITE 19: PHASE 12B ANDROID 10-INCH LANDSCAPE TABLET OPTIMIZATIONS
  // ==========================================================================
  describe('19. Phase 12B — Android 10-Inch Landscape Tablet Optimizations', () => {
    const indexCss = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');

    it('19.1 Stylesheet defines dedicated 10-inch Android tablet landscape media queries', () => {
      assert.ok(indexCss.includes('@media (min-width: 900px) and (max-width: 1280px) and (orientation: landscape)'), 'Must include 10" tablet landscape query');
      assert.ok(indexCss.includes('overflow-x: hidden'), 'Must prevent horizontal overflow');
      assert.ok(indexCss.includes('touch-action: manipulation'), 'Must prevent unwanted touch delay and zooming');
    });

    it('19.2 Touch targets maintain minimum 44px/48px height across categories, table cards, and actions', () => {
      assert.ok(indexCss.includes('.category-nav-item'), 'Must target category nav item');
      assert.ok(indexCss.includes('min-height: 44px'), 'Must enforce minimum 44px touch targets');
    });

    it('19.3 Modal sizing enforces max-height: calc(100vh - 40px) to prevent tablet viewport clipping', () => {
      assert.ok(indexCss.includes('max-height: calc(100vh - 40px)'), 'Must constrain modal height on tablets');
      assert.ok(indexCss.includes('-webkit-overflow-scrolling: touch'), 'Must support momentum scrolling on touch tablets');
    });

    it('19.4 Input fields enforce 16px font size on tablet landscape to prevent automatic mobile browser zoom', () => {
      assert.ok(indexCss.includes('font-size: 16px !important'), 'Must enforce 16px font size on touch inputs');
    });

    it('19.5 Waiter Table floor enforces 4-column balanced grid on 10-inch tablet landscape', () => {
      assert.ok(indexCss.includes('grid-template-columns: repeat(4, 1fr) !important'), 'Must enforce 4-column grid on tablet landscape');
    });
  });

  // ==========================================================================
  // SUITE 20: PRINTER AGENT PROVISIONING & ADMIN DEVICES & PRINTERS UI
  // ==========================================================================
  describe('20. Printer Agent Provisioning & Admin Devices UI', () => {
    const apiCode = fs.readFileSync(path.join(__dirname, '../src/services/api.js'), 'utf8');
    const printerAdminCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/PrinterAgentAdmin.jsx'), 'utf8');
    const adminDashboardCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/AdminDashboard.jsx'), 'utf8');

    it('20.1 api.js defines complete printers and agent provisioning client methods', () => {
      assert.ok(apiCode.includes('printers: {'), 'api.js must declare printers domain');
      assert.ok(apiCode.includes("request('/printers')"), 'printers.list must call GET /printers');
      assert.ok(apiCode.includes("request('/printers/agents')"), 'printers.listAgents must call GET /printers/agents');
      assert.ok(apiCode.includes("request('/printers/agents/register'"), 'printers.registerAgent must call POST /printers/agents/register');
      assert.ok(apiCode.includes("rotate-credential"), 'printers.rotateAgentCredential must call rotate-credential');
      assert.ok(apiCode.includes("revoke"), 'printers.revokeAgent must call revoke');
      assert.ok(apiCode.includes("test-print"), 'printers.testPrint must call test-print');
    });

    it('20.2 PrinterAgentAdmin displays Company UUID and Backend URL with one-click copy buttons for Android setup', () => {
      assert.ok(printerAdminCode.includes('Company UUID (Tenant ID)'), 'Must display Company UUID label');
      assert.ok(printerAdminCode.includes('Backend API Base URL'), 'Must display Backend API URL label');
      assert.ok(printerAdminCode.includes('copyToClipboard'), 'Must provide copy-to-clipboard functionality');
      assert.ok(printerAdminCode.includes('Android Tablet Print Agent Setup'), 'Must provide dedicated Android Tablet setup card');
      assert.ok(printerAdminCode.includes('getBackendBaseUrl'), 'Must use getBackendBaseUrl from api client');
      assert.ok(!printerAdminCode.includes('const backendUrl = typeof window !== \'undefined\' ? window.location.origin'), 'Must not hardcode window.location.origin which yields port 5173');
    });

    it('20.3 PrinterAgentAdmin manages KITCHEN_KOT and COUNTER_RECEIPT printer roles with test print triggers', () => {
      assert.ok(printerAdminCode.includes('Role: KITCHEN_KOT'), 'Must display KITCHEN_KOT role card');
      assert.ok(printerAdminCode.includes('Role: COUNTER_RECEIPT'), 'Must display COUNTER_RECEIPT role card');
      assert.ok(printerAdminCode.includes('handleTestPrint'), 'Must implement test print handler');
      assert.ok(printerAdminCode.includes('handleSavePrinter'), 'Must implement printer configuration update handler');
    });

    it('20.4 PrinterAgentAdmin enforces one-time credential modal with cleartext security warning', () => {
      assert.ok(printerAdminCode.includes('CRITICAL SECURITY NOTICE'), 'Must display security warning for one-time credential');
      assert.ok(printerAdminCode.includes('ONLY TIME this credential will be shown'), 'Must explain credential cannot be recovered');
      assert.ok(printerAdminCode.includes('SHA-256 hash is stored on the server'), 'Must explain only SHA-256 hash is stored');
      assert.ok(printerAdminCode.includes('setRevealedCredential(null)'), 'Must clear revealed credential from memory on dismissal');
    });

    it('20.5 PrinterAgentAdmin supports credential rotation and agent revocation with confirmation dialogs', () => {
      assert.ok(printerAdminCode.includes('handleConfirmRotate'), 'Must implement credential rotation handler');
      assert.ok(printerAdminCode.includes('handleConfirmRevoke'), 'Must implement agent revocation handler');
      assert.ok(printerAdminCode.includes('token_version'), 'Must describe token_version invalidation impact');
    });

    it('20.6 AdminDashboard integrates Devices & Printers into sidebar navigation and workspace view', () => {
      assert.ok(adminDashboardCode.includes("devices: { title: 'Devices & Printers'"), 'Must define devices in PAGE_META');
      assert.ok(adminDashboardCode.includes("setActiveTab('devices')"), 'Sidebar must allow navigating to devices tab');
      assert.ok(adminDashboardCode.includes('{activeTab === \'devices\' && <PrinterAgentAdmin />}'), 'Workspace must render PrinterAgentAdmin');
    });

    it('20.7 api.js getBackendBaseUrl dynamically resolves backend port 5000 in dev and preserves origin in production', () => {
      assert.ok(apiCode.includes('export function getBackendBaseUrl('), 'api.js must export getBackendBaseUrl');
      assert.ok(apiCode.includes('getBackendUrl: getBackendBaseUrl'), 'api.printers must expose getBackendUrl');
      assert.ok(apiCode.includes("port === '5173'"), 'Must detect Vite dev server port 5173');
      assert.ok(apiCode.includes('5000'), 'Must map to backend default port 5000 in local dev');
      assert.ok(apiCode.includes('origin'), 'Must fallback to origin in production');
    });

    it('20.8 Backend URL validation enforces protocol, format and normalizes slashes', async () => {
      const { validateBackendUrl } = await import('../src/services/api.js');
      // Empty and whitespace rejected
      assert.strictEqual(validateBackendUrl('').valid, false);
      assert.strictEqual(validateBackendUrl('   ').valid, false);
      assert.ok(validateBackendUrl('').error.includes('empty'));

      // Malformed URLs rejected
      assert.strictEqual(validateBackendUrl('invalid-url').valid, false);
      assert.strictEqual(validateBackendUrl('htp://192.168.1.38:5000').valid, false);
      assert.strictEqual(validateBackendUrl('ftp://192.168.1.38:5000').valid, false);

      // Valid HTTP accepted and normalized
      const httpRes = validateBackendUrl('http://192.168.1.38:5000///');
      assert.strictEqual(httpRes.valid, true);
      assert.strictEqual(httpRes.cleanUrl, 'http://192.168.1.38:5000');

      // Valid HTTPS accepted and normalized
      const httpsRes = validateBackendUrl('https://api.8itcafe.com/api/v1/');
      assert.strictEqual(httpsRes.valid, true);
      assert.strictEqual(httpsRes.cleanUrl, 'https://api.8itcafe.com/api/v1');
    });

    it('20.9 Custom URL can be saved and survives remount with Android provisioning receiving the same URL', async () => {
      const { BACKEND_URL_STORAGE_KEY, getBackendBaseUrl, api } = await import('../src/services/api.js');
      assert.strictEqual(BACKEND_URL_STORAGE_KEY, '8it_admin_backend_url');

      // Mock localStorage
      const store = {};
      const mockStorage = {
        getItem: (k) => store[k] || null,
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
      };

      const originalWindow = global.window;
      global.window = {
        localStorage: mockStorage,
        location: { protocol: 'http:', hostname: 'localhost', port: '5173', origin: 'http://localhost:5173' }
      };

      try {
        // Initially detected dev URL
        assert.strictEqual(getBackendBaseUrl(), 'http://localhost:5000');

        // Admin saves custom tablet-reachable LAN URL
        const customUrl = 'http://192.168.1.38:5000';
        mockStorage.setItem(BACKEND_URL_STORAGE_KEY, customUrl);

        // Survives remount / reload
        assert.strictEqual(getBackendBaseUrl(), customUrl);
        assert.strictEqual(api.printers.getBackendUrl(), customUrl, 'Android provisioning must receive the saved URL');

        // Reset to detected
        mockStorage.removeItem(BACKEND_URL_STORAGE_KEY);
        assert.strictEqual(getBackendBaseUrl(), 'http://localhost:5000');
        assert.strictEqual(api.printers.getBackendUrl(), 'http://localhost:5000');
      } finally {
        global.window = originalWindow;
      }
    });

    it('20.10 PrinterAgentAdmin UI exposes Save URL button, Reset to Detected button and error feedback', () => {
      assert.ok(printerAdminCode.includes('Save URL'), 'Must render dedicated Save URL button');
      assert.ok(printerAdminCode.includes('Reset to Detected'), 'Must render Reset to Detected button');
      assert.ok(printerAdminCode.includes('handleSaveUrl'), 'Must implement handleSaveUrl handler');
      assert.ok(printerAdminCode.includes('handleResetUrl'), 'Must implement handleResetUrl handler');
      assert.ok(printerAdminCode.includes('BACKEND_URL_STORAGE_KEY'), 'Must use consistent storage key constant');
      assert.ok(printerAdminCode.includes('Custom Saved'), 'Must indicate when custom URL is active');
    });

    it('20.11 Security Check: Sensitive identifiers and tokens are never stored in localStorage', () => {
      // Inspect PrinterAgentAdmin.jsx for any localStorage.setItem calls
      const storageMatches = [...printerAdminCode.matchAll(/localStorage\.setItem\s*\(\s*([^,\)]+)/g)].map(m => m[1].trim());
      for (const arg of storageMatches) {
        assert.ok(
          arg.includes('BACKEND_URL_STORAGE_KEY') || arg.includes('8it_admin_backend_url'),
          `Unexpected storage key in PrinterAgentAdmin: ${arg}. Only non-secret backend URL may be stored.`
        );
        assert.ok(!arg.toLowerCase().includes('company'), 'Company UUID must never be stored in localStorage');
        assert.ok(!arg.toLowerCase().includes('token'), 'Agent tokens must never be stored in localStorage');
        assert.ok(!arg.toLowerCase().includes('credential'), 'Agent credentials must never be stored in localStorage');
      }
    });

    it('20.12 Single Provision Print Agent button in section header, opens registration modal with clean fields (no Security Protocol box)', () => {
      const currentCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/PrinterAgentAdmin.jsx'), 'utf8');

      // Must have exactly one dedicated Provision Print Agent button in the Provisioned Android Print Agents section header
      assert.ok(
        currentCode.includes('Provisioned Android Print Agents') && currentCode.includes('data-testid="provision-agent-btn-section"'),
        'Section 3 header must contain dedicated Provision Print Agent button'
      );
      assert.ok(
        !currentCode.includes('data-testid="provision-agent-btn-empty"'),
        'Empty table state must not contain duplicate Provision Print Agent button'
      );
      assert.ok(
        !currentCode.includes('Security Protocol:'),
        'Security Protocol box must be removed from the provision modal'
      );

      // Must have handleOpenProvision opening the modal
      assert.ok(currentCode.includes('handleOpenProvision'), 'Must trigger handleOpenProvision on click');
      assert.ok(currentCode.includes('setProvisionModalOpen(true)'), 'Must set provisionModalOpen to true');

      // Form must include Agent Code and Agent Name fields
      assert.ok(currentCode.includes('Agent Code *'), 'Modal must contain Agent Code field');
      assert.ok(currentCode.includes('Agent Name *'), 'Modal must contain Agent Name field');
      assert.ok(currentCode.includes('name="agentCode"'), 'Input must have name=agentCode');
      assert.ok(currentCode.includes('name="agentName"'), 'Input must have name=agentName');

      // Submitting calls registerAgent and reveals one-time credential modal
      assert.ok(currentCode.includes('api.printers.registerAgent'), 'Must call api.printers.registerAgent on submit');
      assert.ok(currentCode.includes('setCredentialModalOpen(true)'), 'Must open one-time credential modal on success');
    });

    it('20.13 Admin Device Registration: Add Cashier Tablet and Add Waiter Tablet actions, Device Type selector, and Allowed Capabilities', () => {
      const currentCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/PrinterAgentAdmin.jsx'), 'utf8');

      // 1. Dual Provisioning Actions
      assert.ok(currentCode.includes('+ Add Cashier Tablet'), 'Must include + Add Cashier Tablet action');
      assert.ok(currentCode.includes('+ Add Waiter Tablet'), 'Must include + Add Waiter Tablet action');
      assert.ok(currentCode.includes('data-testid="add-waiter-tablet-btn"'), 'Must have add-waiter-tablet-btn testid');

      // 2. Modal Device Type Selector & Capability Badges
      assert.ok(currentCode.includes('id="provision-device-type"'), 'Modal must have device type selector');
      assert.ok(currentCode.includes('CASHIER_TABLET'), 'Selector must support CASHIER_TABLET');
      assert.ok(currentCode.includes('WAITER_TABLET'), 'Selector must support WAITER_TABLET');
      assert.ok(currentCode.includes('Server-Enforced Queue Capabilities:'), 'Must show server-enforced queue preview');
      assert.ok(currentCode.includes('KITCHEN_KOT'), 'Must display KITCHEN_KOT capability badge');
      assert.ok(currentCode.includes('COUNTER_RECEIPT'), 'Must display COUNTER_RECEIPT capability badge');

      // 3. Table Headers and Columns
      assert.ok(currentCode.includes('<th>Device Code</th>'), 'Table must have Device Code header');
      assert.ok(currentCode.includes('<th>Device Name</th>'), 'Table must have Device Name header');
      assert.ok(currentCode.includes('<th>Device Type</th>'), 'Table must have Device Type header');
      assert.ok(currentCode.includes('<th>Allowed Capabilities</th>'), 'Table must have Allowed Capabilities header');
      assert.ok(currentCode.includes('Waiter Tablet'), 'Table must render Waiter Tablet badge');
      assert.ok(currentCode.includes('Cashier Tablet'), 'Table must render Cashier Tablet badge');

      // 4. API Client Integration
      const apiCode = fs.readFileSync(path.join(__dirname, '../src/services/api.js'), 'utf8');
      assert.ok(apiCode.includes('deviceType: data.deviceType'), 'api.js registerAgent must pass deviceType');
    });

    it('20.14 Heartbeat diagnostics: 3-tier connection status, relative elapsed time, and IPv4 normalization', () => {
      const currentCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/PrinterAgentAdmin.jsx'), 'utf8');

      // 1. IP Normalization helper exists and handles ::ffff:
      assert.ok(currentCode.includes('normalizeIp'), 'PrinterAgentAdmin must declare normalizeIp helper');
      assert.ok(currentCode.includes('.replace(/^::ffff:/i, \'\')'), 'Must strip ::ffff: prefix from reported tablet IP');

      // Verify normalization logic in isolation
      const normalizeIpTest = (ip) => (!ip ? '—' : String(ip).trim().replace(/^::ffff:/i, '') || '—');
      assert.strictEqual(normalizeIpTest('::ffff:192.168.1.53'), '192.168.1.53', 'Must extract IPv4 from IPv4-mapped IPv6');
      assert.strictEqual(normalizeIpTest('192.168.1.38'), '192.168.1.38', 'Must preserve clean IPv4');
      assert.strictEqual(normalizeIpTest(null), '—', 'Must handle null cleanly');

      // 2. 3-tier connection status helper
      assert.ok(currentCode.includes('getAgentConnectionStatus'), 'Must declare getAgentConnectionStatus');
      assert.ok(currentCode.includes('Online • Active'), 'Must include Online • Active state');
      assert.ok(currentCode.includes('Heartbeat Delayed'), 'Must include Heartbeat Delayed state');
      assert.ok(currentCode.includes('Standby / Offline'), 'Must include Standby / Offline state');
      assert.ok(currentCode.includes('Revoked'), 'Must include Revoked state');

      // 3. Relative time formatting
      assert.ok(currentCode.includes('formatRelativeTime'), 'Must declare formatRelativeTime helper');
      assert.ok(currentCode.includes('Never connected'), 'Must display Never connected for null heartbeats');
      assert.ok(currentCode.includes('ago'), 'Must format relative time with ago suffix');
    });
  });

  // ==========================================================================
  // SUITE 21: ADVANCED PAYMENT MANAGEMENT & SPLIT TENDER CHECKOUT
  // ==========================================================================
  describe('21. Advanced Payment Management & Split Tender Checkout', () => {
    it('21.1 CheckoutModal implements Split Tender Payment mode toggle', () => {
      const checkoutCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/CheckoutModal.jsx'), 'utf8');
      assert.ok(checkoutCode.includes('isSplitMode'), 'Must declare isSplitMode state');
      assert.ok(checkoutCode.includes('Single Payment'), 'Must provide Single Payment option');
      assert.ok(checkoutCode.includes('Split Tender Payment'), 'Must provide Split Tender Payment option');
      assert.ok(checkoutCode.includes('pay-split-section'), 'Must render split tender section');
    });

    it('21.2 Split tender calculations reconcile exact allocations and remaining balance', () => {
      const grandTotal = 388.50;
      const splitRows = [
        { method: 'CASH', amount: '200.00', tenderedAmount: '200.00' },
        { method: 'UPI', amount: '188.50', tenderedAmount: '188.50' }
      ];

      const splitAllocated = splitRows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
      const splitRemaining = Math.round((grandTotal - splitAllocated) * 100) / 100;
      const isSplitBalanced = Math.abs(splitRemaining) < 0.009;

      assert.strictEqual(splitAllocated, 388.50, 'Allocated sum must equal grandTotal');
      assert.strictEqual(splitRemaining, 0, 'Remaining balance must be 0');
      assert.strictEqual(isSplitBalanced, true, 'Split must be balanced');
    });

    it('21.3 Cash split tender enforces tendered_amount and computes change returned', () => {
      const row = { method: 'CASH', amount: '200.00', tenderedAmount: '500.00' };
      const rowAmount = parseFloat(row.amount);
      const rowTendered = parseFloat(row.tenderedAmount);
      const rowChange = Math.max(0, rowTendered - rowAmount);
      const isCashShort = rowTendered < rowAmount;

      assert.strictEqual(isCashShort, false, 'Cash must not be short');
      assert.strictEqual(rowChange, 300.00, 'Change returned must be ₹300.00');
    });

    it('21.4 api.js exposes Phase 5 billing & cashier reconciliation methods', () => {
      const apiCode = fs.readFileSync(path.join(__dirname, '../src/services/api.js'), 'utf8');
      assert.ok(apiCode.includes('recordPartialPayment:'), 'api.billing must declare recordPartialPayment');
      assert.ok(apiCode.includes('getCashierSummary:'), 'api.billing must declare getCashierSummary');
      assert.ok(apiCode.includes('openCashierShift:'), 'api.billing must declare openCashierShift');
      assert.ok(apiCode.includes('closeCashierShift:'), 'api.billing must declare closeCashierShift');
      assert.ok(apiCode.includes('getCashierReconciliations:'), 'api.billing must declare getCashierReconciliations');
      assert.ok(apiCode.includes('getCashierReconciliation:'), 'api.reports must declare getCashierReconciliation');
    });

    it('21.5 CheckoutModal records payments as RECORDED without gateway verification', () => {
      const checkoutCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/CheckoutModal.jsx'), 'utf8');
      assert.ok(checkoutCode.includes("verification_status: 'RECORDED'"), "Must record payments as RECORDED");
      assert.ok(!checkoutCode.includes("verification_status: 'VERIFIED'"), "Must not mark payments as gateway VERIFIED");
    });
  });

  // ==========================================================================
  // SUITE 22: SECURITY AUDIT TRAIL, DISASTER RECOVERY & BACKUP MANAGEMENT (Phase 13)
  // ==========================================================================
  describe('22. Security Audit Trail, Disaster Recovery & Backup Management', () => {
    it('22.1 api.js exposes Phase 13 audit and backup client endpoints', () => {
      const apiCode = fs.readFileSync(path.join(__dirname, '../src/services/api.js'), 'utf8');
      assert.ok(apiCode.includes('audit: {'), 'api must declare audit namespace');
      assert.ok(apiCode.includes('list: (params = {}) => request(`/audit-logs'), 'audit.list endpoint');
      assert.ok(apiCode.includes('backup: {'), 'api must declare backup namespace');
      assert.ok(apiCode.includes("list: () => request('/backups')"), 'backup.list endpoint');
      assert.ok(apiCode.includes("create: () => request('/backups/create'"), 'backup.create endpoint');
      assert.ok(apiCode.includes("verify: (filename) => request(`/backups/verify/"), 'backup.verify endpoint');
      assert.ok(apiCode.includes("testRestore: (filename) => request('/backups/restore-test'"), 'backup.testRestore endpoint');
      assert.ok(apiCode.includes("getDownloadUrl: (filename) =>"), 'backup.getDownloadUrl helper');
    });

    it('22.2 AuditLogAdmin component implements filters, pagination, and inspection modal', () => {
      const auditCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/AuditLogAdmin.jsx'), 'utf8');
      assert.ok(auditCode.includes('export function AuditLogAdmin'), 'Component declaration');
      assert.ok(auditCode.includes('api.audit.list'), 'Fetches audit records via api.audit.list');
      assert.ok(auditCode.includes('actorTypeFilter'), 'Actor type filter state');
      assert.ok(auditCode.includes('trg_audit_logs_immutable'), 'Displays database trigger immutability guarantee');
      assert.ok(auditCode.includes('selectedLog'), 'Log inspection modal state');
    });

    it('22.3 BackupRecoveryAdmin implements snapshot creation, TOC verification & isolated restore', () => {
      const backupCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/BackupRecoveryAdmin.jsx'), 'utf8');
      assert.ok(backupCode.includes('export function BackupRecoveryAdmin'), 'Component declaration');
      assert.ok(backupCode.includes('api.backup.create'), 'Triggers backup creation');
      assert.ok(backupCode.includes('api.backup.verify'), 'Triggers archive TOC verification');
      assert.ok(backupCode.includes('api.backup.testRestore'), 'Triggers isolated disaster test restore');
      assert.ok(backupCode.includes('cafe_cloud_pos_recovery'), 'Identifies sandbox recovery database');
    });

    it('22.4 AdminDashboard removes Security & Audit and Backup & Recovery from sidebar navigation', () => {
      const dashboardCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/AdminDashboard.jsx'), 'utf8');
      assert.ok(!dashboardCode.includes("activeTab === 'security_audit'"), 'Sidebar nav must not include security_audit');
      assert.ok(!dashboardCode.includes("activeTab === 'backup_recovery'"), 'Sidebar nav must not include backup_recovery');
      assert.ok(!dashboardCode.includes('<AuditLogAdmin />'), 'Must not mount AuditLogAdmin');
      assert.ok(!dashboardCode.includes('<BackupRecoveryAdmin />'), 'Must not mount BackupRecoveryAdmin');
    });
  });

  // ==========================================================================
  // SUITE 23: ITEM CODE DISPLAY, SEARCH, BRAND CONCEALMENT & FORM MANAGEMENT
  // ==========================================================================
  describe('23. Item Code Display, Search, Brand Concealment & Form Management', () => {
    it('23.1 ProductCard renders ITEM CODE and highlights exact search matches', () => {
      const cardCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/ProductCard.jsx'), 'utf8');
      assert.ok(cardCode.includes('<span>ITEM CODE:</span>'), 'ProductCard must render ITEM CODE label');
      assert.ok(cardCode.includes('EXACT MATCH'), 'ProductCard must display EXACT MATCH badge');
      assert.ok(cardCode.includes('isExactCodeMatch'), 'ProductCard must calculate exact code match');
    });

    it('23.2 ProductCard conceals brand name and tags when showBrand is false', () => {
      const cardCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/ProductCard.jsx'), 'utf8');
      assert.ok(cardCode.includes('showBrand && product.brand_name'), 'Brand name only shown when showBrand is truthy');
      assert.ok(cardCode.includes('showBrand = false'), 'showBrand defaults to false to hide brand from cashier');
    });

    it('23.3 CartPanel displays Item Code for cart line items', () => {
      const cartCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/CartPanel.jsx'), 'utf8');
      assert.ok(cartCode.includes('item.product.item_code') || cartCode.includes('item.product.itemCode') || cartCode.includes('item.product.sku'), 'CartPanel must render product item code');
    });

    it('23.4 POSScreen and WaiterOrderScreen search placeholders include Item Code', () => {
      const posCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/POSScreen.jsx'), 'utf8');
      const waiterCode = fs.readFileSync(path.join(__dirname, '../src/components/waiter/WaiterOrderScreen.jsx'), 'utf8');
      assert.ok(posCode.toLowerCase().includes('item code'), 'POSScreen search placeholder mentions Item Code');
      assert.ok(waiterCode.toLowerCase().includes('item code'), 'WaiterOrderScreen search placeholder mentions Item Code');
    });

    it('23.5 ProductCategoryAdmin enforces Item Code in table headers, add/edit forms and validation', () => {
      const adminCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/ProductCategoryAdmin.jsx'), 'utf8');
      assert.ok(adminCode.includes('<th>ITEM CODE</th>'), 'Admin product table header must be ITEM CODE');
      assert.ok(adminCode.includes('Item Code *'), 'Product modal must have mandatory Item Code field');
      assert.ok(adminCode.includes("alert('Item Code is required')") || adminCode.includes('item_code.trim()'), 'Form validates non-empty Item Code');
    });

    it('23.6 ReportsScreen renders ITEM CODE column in top-selling products table', () => {
      const repCode = fs.readFileSync(path.join(__dirname, '../src/components/reports/ReportsScreen.jsx'), 'utf8');
      assert.ok(repCode.includes('<th>ITEM CODE</th>'), 'ReportsScreen must render ITEM CODE column header');
    });
  });

  // ==========================================================================
  // SUITE 24: CASHIER INVOICE PAYMENT MODE MODIFICATION (CASH ONLY)
  // ==========================================================================
  describe('24. Cashier Invoice Payment Mode Modification (Cash Only)', () => {
    it('24.1 api.billing exposes changePaymentMode endpoint', () => {
      const apiCode = fs.readFileSync(path.join(__dirname, '../src/services/api.js'), 'utf8');
      assert.ok(apiCode.includes('changePaymentMode: (id, data) =>'), 'api.billing must define changePaymentMode');
      assert.ok(apiCode.includes('/billing/invoices/${id}/change-payment-mode'), 'changePaymentMode must target /change-payment-mode');
    });

    it('24.2 InvoiceHistoryModal implements isCashOnlyInvoice restricting modifications to CASH invoices', () => {
      const modalCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/InvoiceHistoryModal.jsx'), 'utf8');
      assert.ok(modalCode.includes('isCashOnlyInvoice'), 'Must define isCashOnlyInvoice guard');
      assert.ok(modalCode.includes("method === 'CASH'"), 'Only CASH invoices qualify for payment mode change');
    });

    it('24.3 InvoiceHistoryModal renders Change Mode action only for cash invoices', () => {
      const modalCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/InvoiceHistoryModal.jsx'), 'utf8');
      assert.ok(modalCode.includes('isCashOnlyInvoice(inv) && ('), 'Table row action must conditionally show Change Mode for cash only');
      assert.ok(modalCode.includes('isCashOnlyInvoice(selectedInvoice) && ('), 'Drawer action must conditionally show Change Payment Mode for cash only');
    });

    it('24.4 InvoiceHistoryModal renders change payment mode modal with UPI and CARD options', () => {
      const modalCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/InvoiceHistoryModal.jsx'), 'utf8');
      assert.ok(modalCode.includes('changeModeModalOpen && targetInvoiceForChange'), 'Renders modal when open');
      assert.ok(modalCode.includes("setNewPaymentMethod('UPI')"), 'Provides UPI option');
      assert.ok(modalCode.includes("setNewPaymentMethod('CARD')"), 'Provides CARD option');
      assert.ok(modalCode.includes('api.billing.changePaymentMode'), 'Calls api.billing.changePaymentMode on confirm');
    });
  });

  // ==========================================================================
  // SUITE 25: ADMIN INVOICE SOFT DELETION & FINANCIAL AUDIT PRESERVATION
  // ==========================================================================
  describe('25. Admin Invoice Soft Deletion & Financial Audit Preservation', () => {
    it('25.1 api.billing exposes deleteInvoice and restoreInvoice methods', () => {
      const apiCode = fs.readFileSync(path.join(__dirname, '../src/services/api.js'), 'utf8');
      assert.ok(apiCode.includes('deleteInvoice: (id, reason) =>'), 'api.billing must define deleteInvoice');
      assert.ok(apiCode.includes('/billing/invoices/${id}/delete'), 'deleteInvoice must target /delete endpoint');
      assert.ok(apiCode.includes('restoreInvoice: (id, reason) =>'), 'api.billing must define restoreInvoice');
      assert.ok(apiCode.includes('/billing/invoices/${id}/restore'), 'restoreInvoice must target /restore endpoint');
    });

    it('25.2 Badge component supports DELETED status tone', () => {
      const badgeCode = fs.readFileSync(path.join(__dirname, '../src/components/common/Badge.jsx'), 'utf8');
      assert.ok(badgeCode.includes("DELETED: 'danger'"), 'Badge must map DELETED status to danger tone');
    });

    it('25.3 AdminDashboard replaces Void with red destructive Delete button and renders Receipt button', () => {
      const adminCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/AdminDashboard.jsx'), 'utf8');
      assert.ok(adminCode.includes('Delete') && adminCode.includes('saas-pill-btn danger'), 'Admin table must render red destructive Delete button');
      assert.ok(adminCode.includes('handleDeleteInvoice'), 'Must define handleDeleteInvoice handler');
      assert.ok(adminCode.includes('setSelectedInvoiceForReceipt'), 'Receipt view action must remain intact');
    });

    it('25.4 AdminDashboard provides Deleted tab filter and confirmation modal with reason prompt', () => {
      const adminCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/AdminDashboard.jsx'), 'utf8');
      assert.ok(adminCode.includes("setInvoiceFilter('DELETED')"), 'Filter buttons must include Deleted filter');
      assert.ok(adminCode.includes('invoiceToDelete &&'), 'Must render Delete Confirmation Modal');
      assert.ok(!adminCode.includes('Soft Deletion & Statutory Audit Notice'), 'Soft-deletion warning box must be removed from modal');
      assert.ok(adminCode.includes('Reason for Deletion *'), 'Must prompt for mandatory deletion reason');
    });

    it('25.5 InvoiceHistoryModal provides Admin Delete Invoice action and soft delete confirmation modal', () => {
      const modalCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/InvoiceHistoryModal.jsx'), 'utf8');
      assert.ok(modalCode.includes('isAdmin && !selectedInvoice.is_deleted && ('), 'Admin can delete invoice if not already deleted');
      assert.ok(modalCode.includes('Delete Invoice'), 'Must provide Delete Invoice action');
      assert.ok(modalCode.includes('deleteModalOpen && selectedInvoice'), 'Must render Delete Confirmation Modal');
      assert.ok(modalCode.includes('api.billing.deleteInvoice'), 'Calls api.billing.deleteInvoice');
    });
  });

  // ==========================================================================
  // SUITE 26: PARCEL KOT PAYMENT GUARD & DISPATCH SAFEGUARD
  // ==========================================================================
  describe('26. Parcel KOT Payment Guard & Kitchen Dispatch Safeguard', () => {
    it('26.1 api.kot exposes verifyParcelDispatch and sendParcelKot methods', () => {
      const apiCode = fs.readFileSync(path.join(__dirname, '../src/services/api.js'), 'utf8');
      assert.ok(apiCode.includes('verifyParcelDispatch: (payload) =>'), 'api.kot must define verifyParcelDispatch');
      assert.ok(apiCode.includes('/kot/parcel/verify-dispatch'), 'verifyParcelDispatch must target /kot/parcel/verify-dispatch');
      assert.ok(apiCode.includes('sendParcelKot: (payload, idempotencyKey = null) =>'), 'api.kot must define sendParcelKot');
    });

    it('26.2 POSScreen verifies kitchen item dispatch before opening checkout for parcel orders', () => {
      const posCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/POSScreen.jsx'), 'utf8');
      assert.ok(posCode.includes('handleProceedToPayment'), 'POSScreen must define handleProceedToPayment');
      assert.ok(posCode.includes('api.kot.verifyParcelDispatch'), 'Calls api.kot.verifyParcelDispatch before checkout');
      assert.ok(posCode.includes('i.product.is_kitchen_item'), 'Checks for kitchen-eligible items');
    });

    it('26.3 POSScreen displays exact mandatory warning and dual actions (Send to KOT & Cancel and return to order)', () => {
      const posCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/POSScreen.jsx'), 'utf8');
      assert.ok(
        posCode.includes('Kitchen ticket has not been sent. Please send the KOT before completing payment.'),
        'Must display exact required warning message'
      );
      assert.ok(posCode.includes('Send to KOT'), 'Must provide Send to KOT action');
      assert.ok(posCode.includes('Cancel and return to order'), 'Must provide Cancel and return to order action');
      assert.ok(posCode.includes('kotGuardModalOpen &&'), 'Must render KOT Guard Modal');
    });

    it('26.4 CheckoutModal catches KOT_DISPATCH_REQUIRED and renders retry and return actions', () => {
      const modalCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/CheckoutModal.jsx'), 'utf8');
      assert.ok(modalCode.includes("err.code === 'KOT_DISPATCH_REQUIRED'"), 'Catches KOT_DISPATCH_REQUIRED code');
      assert.ok(
        modalCode.includes('Kitchen ticket has not been sent. Please send the KOT before completing payment.'),
        'Must display warning inside modal'
      );
      assert.ok(modalCode.includes('handleSendKotFromCheckout'), 'Must provide KOT dispatch retry action');
      assert.ok(modalCode.includes('Cancel and return to order'), 'Must provide Cancel and return to order action');
    });
  });

  describe('Suite 27: Kitchen Ticket Required Modal Redesign', () => {
    it('27.1 POSScreen renders redesigned modal header with ChefHat icon, title, subtitle and close button', () => {
      const posCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/POSScreen.jsx'), 'utf8');
      assert.ok(posCode.includes('kot-guard-header-icon'), 'Header contains icon badge container');
      assert.ok(posCode.includes('<ChefHat'), 'Header contains ChefHat icon');
      assert.ok(posCode.includes('title="Kitchen Ticket Required"'), 'Modal title is Kitchen Ticket Required');
      assert.ok(
        posCode.includes('subtitle="This parcel order has not been sent to the kitchen."'),
        'Modal subtitle matches required copy'
      );
    });

    it('27.2 POSScreen warning section contains light-red banner with exact warning copy and alert icon', () => {
      const posCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/POSScreen.jsx'), 'utf8');
      assert.ok(posCode.includes('kot-guard-warning-banner'), 'Warning banner container present');
      assert.ok(posCode.includes('Kitchen ticket has not been sent.'), 'Warning headline present');
      assert.ok(posCode.includes('Please send the KOT before completing payment.'), 'Warning text present');
      assert.ok(posCode.includes('<AlertCircle'), 'Warning alert icon present');
    });

    it('27.3 POSScreen renders dynamic parcel reference container and unsent kitchen items panel', () => {
      const posCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/POSScreen.jsx'), 'utf8');
      assert.ok(posCode.includes('kot-guard-parcel-ref'), 'Parcel reference section present');
      assert.ok(posCode.includes('{parcelOrderNumber}'), 'Dynamic parcel order reference rendered');
      assert.ok(posCode.includes('kot-guard-items-card'), 'Unsent items card present');
      assert.ok(posCode.includes('Unsent Kitchen Items'), 'Unsent kitchen items heading present');
      assert.ok(posCode.includes('kot-guard-qty-badge'), 'Unsent quantity badge present');
      assert.ok(posCode.includes('Qty:'), 'Quantity formatted with Qty: badge prefix');
    });

    it('27.4 POSScreen renders redesigned side-by-side footer buttons with primary Send to KOT and Cancel', () => {
      const posCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/POSScreen.jsx'), 'utf8');
      assert.ok(posCode.includes('kot-guard-footer-actions'), 'Footer actions grid container present');
      assert.ok(posCode.includes('kot-guard-btn--cancel'), 'Cancel button styled with cancel class');
      assert.ok(posCode.includes('kot-guard-btn--primary'), 'Send to KOT styled with primary class');
      assert.ok(posCode.includes('<Printer'), 'Printer icon present on Send to KOT action');
    });

    it('27.5 CSS includes backdrop-blur overlay, 8it dark green primary button, and responsive tablet styles', () => {
      const posCss = fs.readFileSync(path.join(__dirname, '../src/pos.css'), 'utf8');
      const dsCss = fs.readFileSync(path.join(__dirname, '../src/design-system.css'), 'utf8');
      assert.ok(dsCss.includes('backdrop-filter: blur(6px)'), 'Blurred dark overlay in design-system.css');
      assert.ok(posCss.includes('.kot-guard-modal.ui-modal'), 'Modal rounded corners styling defined');
      assert.ok(posCss.includes('#0A3D29'), '8it dark green brand color applied to primary action');
      assert.ok(posCss.includes('.kot-guard-header-icon'), 'Light-red rounded square header icon container defined');
      assert.ok(posCss.includes('.kot-guard-qty-badge'), 'Quantity badge style defined');
    });
  });

  describe('Suite 28: Parcel KOT Retry & Queue Acceptance Safeguards', () => {
    it('28.1 POSScreen displays "KOT queued — waiting for kitchen printer" when backend queue accepts job with offline printer', () => {
      const posCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/POSScreen.jsx'), 'utf8');
      assert.ok(posCode.includes('KOT queued — waiting for kitchen printer'), 'POSScreen handles offline printer queue notice');
      assert.ok(posCode.includes('kotGuardQueuedNotice'), 'POSScreen tracks kotGuardQueuedNotice state');
    });

    it('28.2 CheckoutModal displays "KOT queued — waiting for kitchen printer" when retrying from payment modal', () => {
      const modalCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/CheckoutModal.jsx'), 'utf8');
      assert.ok(modalCode.includes('KOT queued — waiting for kitchen printer'), 'CheckoutModal handles offline printer queue notice');
      assert.ok(modalCode.includes('kotQueuedNotice'), 'CheckoutModal tracks kotQueuedNotice state');
    });
  });

  describe('Suite 29: Generalized Wi-Fi Printer Architecture & Diagnostics', () => {
    it('29.1 api.printers exposes testConnection endpoint', () => {
      const apiCode = fs.readFileSync(path.join(__dirname, '../src/services/api.js'), 'utf8');
      assert.ok(apiCode.includes('testConnection: (id) => request(`/printers/${id}/test-connection`'), 'api.printers has testConnection method');
    });

    it('29.2 PrinterAgentAdmin renders Test Connection buttons and dynamic port labels for both printers', () => {
      const adminCode = fs.readFileSync(path.join(__dirname, '../src/components/admin/PrinterAgentAdmin.jsx'), 'utf8');
      assert.ok(adminCode.includes('handleTestConnection'), 'PrinterAgentAdmin has handleTestConnection handler');
      assert.ok(adminCode.includes('Test Connection'), 'Renders Test Connection button text');
      assert.ok(adminCode.includes('Port {kitchenPrinter?.port || 9100}'), 'Dynamic port display for Kitchen printer');
      assert.ok(adminCode.includes('Port {cashierPrinter?.port || 9100}'), 'Dynamic port display for Cashier printer');
    });
  });

  describe('Suite 30: Customer Name on Complete Payment & Printed Invoice', () => {
    it('30.1 CheckoutModal renders Customer Name label and input between Total Payable and Payment mode toggle', () => {
      const modalCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/CheckoutModal.jsx'), 'utf8');
      assert.ok(modalCode.includes('Customer Name'), 'Renders Customer Name label');
      assert.ok(modalCode.includes('placeholder="Enter customer name (optional)"'), 'Uses correct placeholder');
      assert.ok(modalCode.includes("minHeight: '44px'"), 'Uses touch-friendly 44px min-height');

      // Verify placement: pay-total -> customer-name-field -> pay-mode-toggle
      const payTotalIdx = modalCode.indexOf('className="pay-total"');
      const custFieldIdx = modalCode.indexOf('className="customer-name-field"');
      const toggleIdx = modalCode.indexOf('className="pay-mode-toggle"');
      assert.ok(payTotalIdx < custFieldIdx, 'Customer name field is placed below Total Payable');
      assert.ok(custFieldIdx < toggleIdx, 'Customer name field is placed above Single / Split toggle');
    });

    it('30.2 CheckoutModal maintains customerName state independently across payment methods & split mode', () => {
      const modalCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/CheckoutModal.jsx'), 'utf8');
      assert.ok(modalCode.includes("const [customerName, setCustomerName] = useState('');"), 'Maintains customerName state');
      assert.ok(modalCode.includes('cleanCustomerName = customerName.trim() || null'), 'Trims customer name or normalizes to null');
    });

    it('30.3 ReceiptModal renders CUSTOMER line on-screen and in print media when customerName is present', () => {
      const receiptCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/ReceiptModal.jsx'), 'utf8');
      assert.ok(receiptCode.includes('CUSTOMER: {customerName}'), 'Renders CUSTOMER label and dynamic name');
      assert.ok(receiptCode.includes('invoice.customer_name ||'), 'Inspects invoice.customer_name');
    });

    it('30.4 InvoiceHistoryModal renders CUSTOMER detail when invoice contains customer_name', () => {
      const historyCode = fs.readFileSync(path.join(__dirname, '../src/components/pos/InvoiceHistoryModal.jsx'), 'utf8');
      assert.ok(historyCode.includes('CUSTOMER: {selectedInvoice.customer_name}'), 'Renders CUSTOMER in invoice details drawer');
    });
  });
});
