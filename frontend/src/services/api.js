/**
 * Cafe Cloud POS — Centralized API Client
 * Manages JWT tokens, standardized envelopes, idempotency keys, and domain endpoints.
 */

const API_BASE = '/api/v1';
const TOKEN_KEY = 'cafe_access_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Generate cryptographically secure UUIDv4 for idempotency and unique IDs.
 */
export function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Core HTTP Request Wrapper
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const token = getToken();
  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const config = {
    method: options.method || 'GET',
    headers,
    ...options
  };

  if (options.body && typeof options.body === 'object') {
    config.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(url, config);
  } catch (networkErr) {
    const err = new Error(networkErr.message || 'Network connection failed. Please check your internet connection.');
    err.code = 'NETWORK_ERROR';
    err.statusCode = 0;
    throw err;
  }

  let json = null;
  try {
    json = await response.json();
  } catch {
    // Response had no JSON body
  }

  if (!response.ok) {
    // Handle Session Expiry or Invalid Token
    if (response.status === 401 && !endpoint.includes('/auth/login')) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('cafe_auth_expired', { detail: { endpoint } }));
      }
    }

    const errorObj = (json && json.error) ? json.error : {};
    const err = new Error(errorObj.message || `Request failed with status ${response.status}`);
    err.code = errorObj.code || 'HTTP_ERROR';
    err.statusCode = response.status;
    err.details = errorObj.details || null;
    err.meta = json?.meta || null;
    throw err;
  }

  return json;
}

// ============================================================================
// DOMAIN ENDPOINT METHODS
// ============================================================================

export const api = {
  // Authentication & Staff PIN
  auth: {
    login: (username, password) =>
      request('/auth/login', { method: 'POST', body: { username, password } }),
    getMe: () =>
      request('/auth/me'),
    logout: () =>
      request('/auth/logout', { method: 'POST' }),
    switchCashier: (targetUserId, pin) =>
      request('/auth/switch-cashier', { method: 'POST', body: { targetUserId, pin } }),
    setupPin: (pin) =>
      request('/auth/pin/setup', { method: 'POST', body: { pin } }),
    changePin: (currentPin, newPin) =>
      request('/auth/pin/change', { method: 'POST', body: { currentPin, newPin } })
  },

  // Company Profile
  company: {
    get: () => request('/company'),
    update: (data) => request('/company', { method: 'PATCH', body: data })
  },

  // Brands Management
  brands: {
    list: () => request('/brands'),
    create: (data) => request('/brands', { method: 'POST', body: data }),
    update: (id, data) => request(`/brands/${id}`, { method: 'PATCH', body: data }),
    toggleStatus: (id, is_active) => request(`/brands/${id}/status`, { method: 'PATCH', body: { is_active } })
  },

  // Categories Management
  categories: {
    list: (brandId = '') => request(`/categories${brandId ? `?brand_id=${encodeURIComponent(brandId)}` : ''}`),
    create: (data) => request('/categories', { method: 'POST', body: data }),
    update: (id, data) => request(`/categories/${id}`, { method: 'PATCH', body: data }),
    toggleStatus: (id, is_active) => request(`/categories/${id}/status`, { method: 'PATCH', body: { is_active } })
  },

  // Products Management
  products: {
    list: (params = {}) => {
      const q = new URLSearchParams();
      if (params.brand_id) q.set('brand_id', params.brand_id);
      if (params.category_id) q.set('category_id', params.category_id);
      if (params.search) q.set('search', params.search);
      if (params.page) q.set('page', params.page);
      if (params.limit) q.set('limit', params.limit);
      if (params.is_active !== undefined) q.set('is_active', params.is_active);
      return request(`/products?${q.toString()}`);
    },
    get: (id) => request(`/products/${id}`),
    create: (data) => request('/products', { method: 'POST', body: data }),
    update: (id, data) => request(`/products/${id}`, { method: 'PATCH', body: data }),
    toggleStatus: (id, is_active) => request(`/products/${id}/status`, { method: 'PATCH', body: { is_active } })
  },

  // Tax Rates & GST
  taxRates: {
    list: () => request('/tax-rates'),
    create: (data) => request('/tax-rates', { method: 'POST', body: data }),
    preview: (data) => request('/tax-rates/calculate-preview', { method: 'POST', body: data }),
    update: (id, data) => request(`/tax-rates/${id}`, { method: 'PATCH', body: data }),
    toggleStatus: (id, is_active) => request(`/tax-rates/${id}/status`, { method: 'PATCH', body: { is_active } })
  },

  // Billing, Invoicing & Checkout
  billing: {
    // Live Server-Authoritative Cart Calculation Preview
    calculateCartPreview: (items, placeOfSupplyState = null) =>
      request('/billing/calculate', {
        method: 'POST',
        body: { items, placeOfSupplyState }
      }),

    // Create Draft or Immediate-Settled Invoice
    createInvoice: (data, idempotencyKey = null) => {
      const headers = {};
      if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
      return request('/billing/invoices', { method: 'POST', headers, body: data });
    },

    // List Invoices with Search & Filters
    listInvoices: (params = {}) => {
      const q = new URLSearchParams();
      if (params.search) q.set('search', params.search);
      if (params.status) q.set('status', params.status);
      if (params.payment_status) q.set('payment_status', params.payment_status);
      if (params.startDate) q.set('startDate', params.startDate);
      if (params.endDate) q.set('endDate', params.endDate);
      if (params.limit) q.set('limit', params.limit);
      if (params.offset) q.set('offset', params.offset);
      return request(`/billing/invoices?${q.toString()}`);
    },

    // Retrieve Single Invoice with Snapshots
    getInvoice: (id) => request(`/billing/invoices/${id}`),

    // Atomic Checkout & Settlement
    checkoutInvoice: (id, tenders, idempotencyKey) => {
      const headers = { 'X-Idempotency-Key': idempotencyKey || generateUUID() };
      return request(`/billing/invoices/${id}/checkout`, {
        method: 'POST',
        headers,
        body: { tenders }
      });
    },

    // Void Invoice (Admin / Manager)
    voidInvoice: (id, reason) =>
      request(`/billing/invoices/${id}/void`, { method: 'POST', body: { reason } }),

    // Refund Invoice (Admin / Manager)
    refundInvoice: (id, refundData) =>
      request(`/billing/invoices/${id}/refund`, { method: 'POST', body: refundData })
  },

  // Staff Users & Roles
  users: {
    list: (params = {}) => {
      const q = new URLSearchParams();
      if (params.includeInactive !== undefined) q.set('includeInactive', params.includeInactive);
      const queryStr = q.toString();
      return request(`/users${queryStr ? `?${queryStr}` : ''}`);
    },
    create: (data) =>
      request('/users', {
        method: 'POST',
        body: {
          username: data.username,
          password: data.password,
          fullName: data.fullName || data.full_name,
          roleId: data.roleId || data.role_id,
          email: data.email || null,
          phone: data.phone || null
        }
      }),
    update: (id, data) =>
      request(`/users/${id}`, {
        method: 'PATCH',
        body: {
          fullName: data.fullName !== undefined ? data.fullName : data.full_name,
          email: data.email,
          phone: data.phone
        }
      }),
    updateRole: (id, roleId) =>
      request(`/users/${id}/role`, {
        method: 'PATCH',
        body: { roleId, role_id: roleId }
      }),
    toggleStatus: (id, isActive) =>
      request(`/users/${id}/status`, {
        method: 'PATCH',
        body: { isActive, is_active: isActive }
      }),
    resetPassword: (id, newPassword) =>
      request(`/users/${id}/reset-password`, {
        method: 'POST',
        body: { newPassword, new_password: newPassword }
      }),
    resetPin: (id, newPin) =>
      request(`/users/${id}/reset-pin`, {
        method: 'POST',
        body: { newPin, new_pin: newPin }
      })
  },

  // Roles
  roles: {
    list: () => request('/roles')
  },

  // Inventory & Recipes
  inventory: {
    getOverview: () => request('/inventory/reports/current-stock'),
    listItems: (params = {}) => {
      const q = new URLSearchParams(params);
      return request(`/inventory/items?${q.toString()}`);
    },
    getItem: (id) => request(`/inventory/items/${id}`),
    createItem: (data) =>
      request('/inventory/items', {
        method: 'POST',
        body: {
          sku: data.sku,
          name: data.name,
          description: data.description || null,
          uomId: data.uomId || data.uom_id,
          itemType: data.itemType || data.item_type || 'RAW_MATERIAL',
          categoryId: data.categoryId || data.category_id || null,
          brandId: data.brandId || data.brand_id || null,
          currentCost: data.currentCost !== undefined ? data.currentCost : (data.cost_price || '0.00'),
          minimumStock: data.minimumStock !== undefined ? data.minimumStock : (data.minimum_stock_level || '0'),
          reorderLevel: data.reorderLevel !== undefined ? data.reorderLevel : (data.reorder_level || '0')
        }
      }),
    updateItem: (id, data) => request(`/inventory/items/${id}`, { method: 'PATCH', body: data }),
    toggleItemActive: (id, isActive) =>
      request(`/inventory/items/${id}/active`, { method: 'PATCH', body: { isActive } }),
    listLocations: () => request('/inventory/locations'),
    listUoms: () => request('/inventory/uom'),
    listAlerts: () => request('/inventory/reports/low-stock'),
    listHistory: (params = {}) => {
      const q = new URLSearchParams(params);
      return request(`/inventory/movements?${q.toString()}`);
    },
    recordAdjustment: (data) => {
      const items = (data.items || []).map(it => ({
        inventoryItemId: it.inventoryItemId || it.item_id || it.inventory_item_id,
        quantity: it.quantity,
        unitCost: it.unitCost !== undefined ? it.unitCost : it.unit_cost,
        notes: it.notes || null
      }));
      return request('/inventory/adjustments', {
        method: 'POST',
        body: {
          locationId: data.locationId || data.location_id || null,
          adjustmentType: data.adjustmentType || data.adjustment_type || 'INCREASE',
          reason: data.reason,
          items,
          notes: data.notes || null
        }
      });
    },
    recordWastage: (data) => {
      const items = (data.items || []).map(it => ({
        inventoryItemId: it.inventoryItemId || it.item_id || it.inventory_item_id,
        quantity: it.quantity,
        unitCost: it.unitCost !== undefined ? it.unitCost : it.unit_cost,
        notes: it.notes || null
      }));
      return request('/inventory/adjustments', {
        method: 'POST',
        body: {
          locationId: data.locationId || data.location_id || null,
          adjustmentType: 'WASTAGE',
          reason: data.reason,
          items,
          notes: data.notes || null
        }
      });
    },
    recordCount: (data) => request('/inventory/counts', { method: 'POST', body: data }),
    getRecipe: (productId, version = null) =>
      request(`/inventory/recipes/${productId}${version ? `?version=${version}` : ''}`),
    listRecipes: (productId = '') =>
      productId ? request(`/inventory/recipes/${productId}`) : Promise.resolve({ data: [] }),
    createRecipe: (data) => {
      const components = (data.components || data.ingredients || []).map(c => ({
        inventoryItemId: c.inventoryItemId || c.item_id || c.inventory_item_id,
        quantity: c.quantity,
        uomId: c.uomId || c.uom_id || null
      }));
      return request('/inventory/recipes', {
        method: 'POST',
        body: {
          productId: data.productId || data.product_id,
          yieldQuantity: data.yieldQuantity || data.yield_quantity || '1',
          yieldUnit: data.yieldUnit || data.yield_unit || 'portion',
          instructions: data.instructions || null,
          components
        }
      });
    },
    getMapping: (productId) => request(`/inventory/mappings/${productId}`),
    listMappings: (productId = '') =>
      productId ? request(`/inventory/mappings/${productId}`) : Promise.resolve({ data: [] }),
    createMapping: (data) =>
      request('/inventory/mappings', {
        method: 'POST',
        body: {
          productId: data.productId || data.product_id,
          inventoryItemId: data.inventoryItemId || data.inventory_item_id || data.item_id,
          quantityMultiplier: data.quantityMultiplier || data.quantity_multiplier || data.conversion_ratio || '1.0'
        }
      })
  },

  // Business Analytics & Reports
  reports: {
    getDashboard: (params = {}) => {
      const q = new URLSearchParams(params);
      return request(`/reports/dashboard?${q.toString()}`);
    },
    getDaily: (date, brandId) => {
      const q = new URLSearchParams({ date: date || '' });
      if (brandId) q.set('brandId', brandId);
      return request(`/reports/sales/daily?${q.toString()}`);
    },
    getWeekly: (date, brandId) => {
      const q = new URLSearchParams({ date: date || '' });
      if (brandId) q.set('brandId', brandId);
      return request(`/reports/sales/weekly?${q.toString()}`);
    },
    getMonthly: (year, month, brandId) => {
      const q = new URLSearchParams({ year, month });
      if (brandId) q.set('brandId', brandId);
      return request(`/reports/sales/monthly?${q.toString()}`);
    },
    getFinancialYear: (year, brandId) => {
      const q = new URLSearchParams({ year });
      if (brandId) q.set('brandId', brandId);
      return request(`/reports/sales/financial-year?${q.toString()}`);
    },
    getBrandWise: (params = {}) => request(`/reports/sales/brand-wise?${new URLSearchParams(params).toString()}`),
    getProductWise: (params = {}) => request(`/reports/sales/product-wise?${new URLSearchParams(params).toString()}`),
    getCategoryWise: (params = {}) => request(`/reports/sales/category-wise?${new URLSearchParams(params).toString()}`),
    getHourly: (date, brandId) => {
      const q = new URLSearchParams({ date: date || '' });
      if (brandId) q.set('brandId', brandId);
      return request(`/reports/sales/hourly?${q.toString()}`);
    },
    getCashierWise: (params = {}) => request(`/reports/cashier-wise?${new URLSearchParams(params).toString()}`),
    getPaymentMethods: (params = {}) => request(`/reports/payments?${new URLSearchParams(params).toString()}`),
    getRefunds: (params = {}) => request(`/reports/refunds?${new URLSearchParams(params).toString()}`),
    getTaxSummary: (params = {}) => request(`/reports/tax-summary?${new URLSearchParams(params).toString()}`),
    getInventory: (locationId = '') => request(`/reports/inventory${locationId ? `?locationId=${locationId}` : ''}`),
    getWastage: (params = {}) => request(`/reports/wastage?${new URLSearchParams(params).toString()}`)
  }
};
