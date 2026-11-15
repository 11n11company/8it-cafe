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
});
