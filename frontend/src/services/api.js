/**
 * Cafe Cloud POS — Centralized API Client
 * Manages JWT tokens, standardized envelopes, idempotency keys, and domain endpoints.
 */

const API_BASE = '/api/v1';
const TOKEN_KEY = 'cafe_access_token';
const LEGACY_TOKEN_KEY = 'cafe_pos_token';

/**
 * Storage key for persisting administrator-configured Backend API Base URL.
 * Non-secret, plain configuration string for Android Print Agent tablet setup.
 */
export const BACKEND_URL_STORAGE_KEY = '8it_admin_backend_url';

/**
 * Validates a potential backend API base URL string.
 *
 * Requirements:
 * - Reject empty / whitespace-only values.
 * - Reject malformed URL format.
 * - Require HTTP or HTTPS protocol.
 * - Normalizes by trimming and stripping unnecessary trailing slashes.
 * - Does not silently substitute a different domain.
 *
 * @param {string} url - Candidate backend API base URL
 * @returns {{ valid: boolean, cleanUrl?: string, error?: string }}
 */
export function validateBackendUrl(url) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    return { valid: false, error: 'Backend API Base URL cannot be empty.' };
  }

  const trimmed = url.trim().replace(/\/+$/, '');

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      error: 'Malformed URL format. Please provide a valid URL (e.g. http://192.168.1.38:5000).'
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: 'URL protocol must be HTTP or HTTPS (e.g. http://192.168.1.38:5000 or https://api.example.com).'
    };
  }

  if (!parsed.hostname) {
    return {
      valid: false,
      error: 'URL must contain a valid hostname or IP address.'
    };
  }

  return { valid: true, cleanUrl: trimmed };
}

/**
 * Resolves the automatically detected backend API base URL without consulting localStorage.
 *
 * Rules:
 * 1. If an explicit environment configuration is provided (VITE_BACKEND_URL or BACKEND_URL), reuse it.
 * 2. In browser local development under Vite dev server (port 5173), dynamically point to the backend
 *    API port (port 5000 / VITE_BACKEND_PORT / process.env.PORT) preserving the current hostname.
 * 3. In production or standalone deployments, return window.location.origin.
 * 4. Never hardcode local IPs or production domains.
 */
export function getDetectedBackendBaseUrl() {
  // 1. If an absolute API_BASE URL was configured, extract its origin
  if (typeof API_BASE === 'string' && (API_BASE.startsWith('http://') || API_BASE.startsWith('https://'))) {
    try {
      return new URL(API_BASE).origin;
    } catch {
      // ignore
    }
  }

  // 2. Explicit environment variable if configured (Vite/Node)
  const envUrl =
    (typeof import.meta !== 'undefined' && import.meta.env && (import.meta.env.VITE_BACKEND_URL || import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL)) ||
    (typeof process !== 'undefined' && process.env && (process.env.VITE_BACKEND_URL || process.env.BACKEND_URL)) ||
    '';
  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }

  // 3. Browser context resolution
  if (typeof window !== 'undefined' && window.location) {
    const { protocol, hostname, port, origin } = window.location;

    // During Vite local development (default port 5173), the frontend proxies to backend port 5000
    if (port === '5173') {
      const backendPort =
        (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_BACKEND_PORT) ||
        (typeof process !== 'undefined' && process.env && process.env.PORT) ||
        '5000';
      return `${protocol}//${hostname}:${backendPort}`;
    }

    // In production, when served from same host/reverse proxy
    return origin;
  }

  // 4. Default fallback
  const defaultPort = (typeof process !== 'undefined' && process.env && process.env.PORT) || '5000';
  return `http://127.0.0.1:${defaultPort}`;
}

/**
 * Resolves the backend API base URL for external clients such as the Android Print Agent.
 *
 * Priority:
 * 1. Custom URL explicitly saved by the administrator in localStorage (if valid).
 * 2. Automatically detected environment or browser URL.
 */
export function getBackendBaseUrl() {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const saved = window.localStorage.getItem(BACKEND_URL_STORAGE_KEY);
      if (saved && typeof saved === 'string' && saved.trim()) {
        const check = validateBackendUrl(saved);
        if (check.valid) {
          return check.cleanUrl;
        }
      }
    } catch {
      // Ignore storage access errors
    }
  }
  return getDetectedBackendBaseUrl();
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(LEGACY_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.clear();
    }
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
/**
 * Builds a query string, dropping undefined / null / empty values
 * (URLSearchParams would otherwise send the literal string "undefined").
 */
function qs(params = {}) {
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, v);
  });
  return q.toString();
}

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const token = getToken();
  const hasAuthHeader = Object.keys(headers).some(k => k.toLowerCase() === 'authorization');
  if (token && !hasAuthHeader) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const config = {
    ...options,
    method: options.method || 'GET',
    headers
  };

  const isBinaryBody =
    (typeof Blob !== 'undefined' && options.body instanceof Blob) ||
    (typeof ArrayBuffer !== 'undefined' && options.body instanceof ArrayBuffer);
  if (options.body && typeof options.body === 'object' && !isBinaryBody) {
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
    // Only dispatch cafe_auth_expired when the authentication token itself is genuinely invalid/expired,
    // or when calling /auth/me and receiving 401. Operational or business errors must NEVER log out the cashier.
    const isExplicitTokenError = response.status === 401 && (
      endpoint.includes('/auth/me') ||
      json?.error?.code === 'TOKEN_EXPIRED' ||
      json?.error?.code === 'TOKEN_REVOKED' ||
      json?.error?.code === 'INVALID_TOKEN' ||
      json?.error?.code === 'UNAUTHORIZED' ||
      json?.error?.message?.toLowerCase().includes('token') ||
      json?.error?.message?.toLowerCase().includes('authorization') ||
      json?.error?.message?.toLowerCase().includes('authentication') ||
      json?.error?.message?.toLowerCase().includes('session has been invalidated')
    );

    if (isExplicitTokenError && !endpoint.includes('/auth/login')) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('cafe_auth_expired', { detail: { endpoint } }));
      }
    }

    const errorObj = (json && json.error) ? json.error : {};
    let defaultMsg = `Request failed with status ${response.status}`;
    if (response.status === 502) {
      defaultMsg = 'Backend service connection failed (HTTP 502 Bad Gateway). Please verify backend connectivity and try again.';
    } else if (response.status === 503) {
      defaultMsg = 'Service temporarily unavailable (HTTP 503). Please try again shortly.';
    } else if (response.status === 504) {
      defaultMsg = 'Gateway timed out (HTTP 504). Please try again.';
    }
    const err = new Error(errorObj.message || defaultMsg);
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
  getBackendBaseUrl,

  // Authentication & Staff PIN
  auth: {
    login: (username, password, companyId) => {
      const body = { username, password };
      if (companyId) {
        body.companyId = companyId;
      }
      return request('/auth/login', { method: 'POST', body });
    },
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
    list: (params = {}) => {
      const inc = typeof params === 'boolean' ? params : (params?.includeInactive || params?.include_inactive);
      return request(`/brands${inc ? '?includeInactive=true' : ''}`);
    },
    create: (data) => request('/brands', { method: 'POST', body: data }),
    update: (id, data) => request(`/brands/${id}`, { method: 'PATCH', body: data }),
    toggleStatus: (id, isActive) =>
      request(`/brands/${id}/status`, {
        method: 'PATCH',
        body: { isActive: Boolean(isActive), is_active: Boolean(isActive) }
      })
  },

  // Categories Management
  categories: {
    list: (brandIdOrParams = '') => {
      let brandId = '';
      let includeInactive = false;
      if (typeof brandIdOrParams === 'string') {
        brandId = brandIdOrParams;
      } else if (brandIdOrParams && typeof brandIdOrParams === 'object') {
        brandId = brandIdOrParams.brandId || brandIdOrParams.brand_id || '';
        includeInactive = Boolean(brandIdOrParams.includeInactive || brandIdOrParams.include_inactive);
      }
      const q = new URLSearchParams();
      if (brandId) q.set('brand_id', brandId);
      if (includeInactive) q.set('include_inactive', 'true');
      const qs = q.toString();
      return request(`/categories${qs ? `?${qs}` : ''}`);
    },
    create: (data) => {
      const brandId = data.brandId || data.brand_id;
      const displayOrder = data.displayOrder !== undefined ? data.displayOrder : (data.display_order !== undefined ? Number(data.display_order) : 0);
      return request('/categories', {
        method: 'POST',
        body: {
          ...data,
          brandId,
          brand_id: brandId,
          displayOrder,
          display_order: displayOrder
        }
      });
    },
    update: (id, data) => {
      const displayOrder = data.displayOrder !== undefined ? data.displayOrder : (data.display_order !== undefined ? Number(data.display_order) : undefined);
      return request(`/categories/${id}`, {
        method: 'PATCH',
        body: {
          ...data,
          ...(displayOrder !== undefined ? { displayOrder, display_order: displayOrder } : {})
        }
      });
    },
    toggleStatus: (id, isActive) =>
      request(`/categories/${id}/status`, {
        method: 'PATCH',
        body: { isActive: Boolean(isActive), is_active: Boolean(isActive) }
      }),
    delete: (id) =>
      request(`/categories/${id}`, {
        method: 'DELETE'
      })
  },

  // Products Management
  products: {
    list: (params = {}) => {
      const q = new URLSearchParams();
      if (params.brand_id || params.brandId) q.set('brand_id', params.brand_id || params.brandId);
      if (params.category_id || params.categoryId) q.set('category_id', params.category_id || params.categoryId);
      if (params.search) q.set('search', params.search);
      if (params.page) q.set('page', params.page);
      if (params.limit) q.set('limit', params.limit);
      if (params.is_active !== undefined) q.set('is_active', params.is_active);
      if (params.includeInactive || params.include_inactive) q.set('include_inactive', 'true');
      return request(`/products?${q.toString()}`);
    },
    get: (id) => request(`/products/${id}`),
    create: (data) => {
      const brandId = data.brandId || data.brand_id;
      const categoryId = data.categoryId || data.category_id;
      const taxRateId = data.taxRateId || data.tax_rate_id;
      const basePrice = data.basePrice !== undefined ? data.basePrice : (data.selling_price !== undefined ? data.selling_price : data.price);
      const hsnSacCode = data.hsnSacCode || data.hsn_code || '996331';
      const isKitchenItem = data.isKitchenItem !== undefined ? Boolean(data.isKitchenItem) : (data.is_kitchen_item !== undefined ? Boolean(data.is_kitchen_item) : false);
      const imageUrl = data.imageUrl !== undefined ? data.imageUrl : (data.image_url !== undefined ? data.image_url : null);
      const itemCode = data.item_code !== undefined ? data.item_code : (data.itemCode !== undefined ? data.itemCode : data.sku);
      return request('/products', {
        method: 'POST',
        body: {
          ...data,
          brandId,
          brand_id: brandId,
          categoryId,
          category_id: categoryId,
          taxRateId,
          tax_rate_id: taxRateId,
          basePrice,
          selling_price: basePrice,
          hsnSacCode,
          hsn_code: hsnSacCode,
          isKitchenItem,
          is_kitchen_item: isKitchenItem,
          imageUrl,
          image_url: imageUrl,
          ...(itemCode !== undefined ? { item_code: itemCode, itemCode } : {})
        }
      });
    },
    update: (id, data) => {
      const categoryId = data.categoryId || data.category_id;
      const taxRateId = data.taxRateId || data.tax_rate_id;
      const basePrice = data.basePrice !== undefined ? data.basePrice : (data.selling_price !== undefined ? data.selling_price : data.price);
      const hsnSacCode = data.hsnSacCode !== undefined ? data.hsnSacCode : data.hsn_code;
      const isKitchenItem = data.isKitchenItem !== undefined ? Boolean(data.isKitchenItem) : (data.is_kitchen_item !== undefined ? Boolean(data.is_kitchen_item) : undefined);
      const imageUrl = data.imageUrl !== undefined ? data.imageUrl : data.image_url;
      const itemCode = data.item_code !== undefined ? data.item_code : (data.itemCode !== undefined ? data.itemCode : undefined);
      return request(`/products/${id}`, {
        method: 'PATCH',
        body: {
          ...data,
          ...(categoryId ? { categoryId, category_id: categoryId } : {}),
          ...(taxRateId ? { taxRateId, tax_rate_id: taxRateId } : {}),
          ...(basePrice !== undefined ? { basePrice, selling_price: basePrice } : {}),
          ...(hsnSacCode !== undefined ? { hsnSacCode, hsn_code: hsnSacCode } : {}),
          ...(isKitchenItem !== undefined ? { isKitchenItem, is_kitchen_item: isKitchenItem } : {}),
          ...(imageUrl !== undefined ? { imageUrl, image_url: imageUrl } : {}),
          ...(itemCode !== undefined ? { item_code: itemCode, itemCode } : {})
        }
      });
    },
    toggleStatus: (id, isActive) =>
      request(`/products/${id}/status`, {
        method: 'PATCH',
        body: { isActive: Boolean(isActive), is_active: Boolean(isActive) }
      }),
    delete: (id) =>
      request(`/products/${id}`, {
        method: 'DELETE'
      })
  },

  // Tax Rates & GST
  taxRates: {
    list: (params = {}) => {
      const inc = typeof params === 'boolean' ? params : (params?.includeInactive || params?.include_inactive);
      return request(`/tax-rates${inc ? '?includeInactive=true' : ''}`);
    },
    create: (data) => request('/tax-rates', { method: 'POST', body: data }),
    preview: (data) => request('/tax-rates/calculate-preview', { method: 'POST', body: data }),
    update: (id, data) => request(`/tax-rates/${id}`, { method: 'PATCH', body: data }),
    toggleStatus: (id, isActive) =>
      request(`/tax-rates/${id}/status`, {
        method: 'PATCH',
        body: { isActive: Boolean(isActive), is_active: Boolean(isActive) }
      })
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
      if (params.includeItems) q.set('includeItems', 'true');
      return request(`/billing/invoices?${q.toString()}`);
    },

    // Retrieve Single Invoice with Snapshots
    getInvoice: (id) => request(`/billing/invoices/${id}`),

    // Atomic Checkout & Settlement
    checkoutInvoice: (id, tendersOrPayload, idempotencyKey) => {
      const headers = { 'X-Idempotency-Key': idempotencyKey || generateUUID() };
      const body = Array.isArray(tendersOrPayload)
        ? { tenders: tendersOrPayload }
        : (tendersOrPayload && tendersOrPayload.tenders ? tendersOrPayload : { tenders: [tendersOrPayload] });
      return request(`/billing/invoices/${id}/checkout`, {
        method: 'POST',
        headers,
        body
      });
    },

    // Void Invoice (Admin / Manager)
    voidInvoice: (id, reason) =>
      request(`/billing/invoices/${id}/void`, { method: 'POST', body: { reason } }),

    // Soft-Delete Invoice (Admin Only - Preserves Financial & Audit Records)
    deleteInvoice: (id, reason) =>
      request(`/billing/invoices/${id}/delete`, { method: 'POST', body: { reason } }),

    // Restore Soft-Deleted Invoice (Admin Recovery Path)
    restoreInvoice: (id, reason) =>
      request(`/billing/invoices/${id}/restore`, { method: 'POST', body: { reason } }),

    // Refund Invoice (Admin / Manager)
    refundInvoice: (id, refundData) =>
      request(`/billing/invoices/${id}/refund`, { method: 'POST', body: refundData }),

    // Change Payment Mode (Cashier, Store Manager, Admin - Cash Invoices Only)
    changePaymentMode: (id, data) =>
      request(`/billing/invoices/${id}/change-payment-mode`, {
        method: 'PATCH',
        body: data
      }),

    // Partial Interim Payment
    recordPartialPayment: (id, paymentData, idempotencyKey = null) => {
      const headers = {};
      if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
      return request(`/billing/invoices/${id}/payments`, {
        method: 'POST',
        headers,
        body: paymentData
      });
    },

    // Cashier Register Daily Summary
    getCashierSummary: (cashierId = null, date = null) => {
      const q = new URLSearchParams();
      if (cashierId) q.set('cashierId', cashierId);
      if (date) q.set('date', date);
      const queryStr = q.toString();
      return request(`/billing/cashier/summary${queryStr ? `?${queryStr}` : ''}`);
    },

    // Open Cashier Shift with Opening Float
    openCashierShift: (openingFloat = '0.00', notes = null) =>
      request('/billing/cashier/shift/open', {
        method: 'POST',
        body: { openingFloat, notes }
      }),

    // Close Cashier Shift & Reconcile Counted Cash
    closeCashierShift: (actualCash, shiftId = null, notes = null) =>
      request('/billing/cashier/shift/close', {
        method: 'POST',
        body: { actualCash, shiftId, notes }
      }),

    // List Cashier Shift Reconciliations (Admin / Manager)
    getCashierReconciliations: (params = {}) => {
      const q = new URLSearchParams();
      if (params.limit) q.set('limit', params.limit);
      if (params.offset) q.set('offset', params.offset);
      const queryStr = q.toString();
      return request(`/billing/cashier/reconciliations${queryStr ? `?${queryStr}` : ''}`);
    }
  },

  // Kitchen Order Ticket (KOT)
  media: {
    // Uploads a product image (Blob/File). Returns { url } to store in product image_url.
    uploadProductImage: (blob) =>
      request('/media/product-images', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'image/jpeg' },
        body: blob
      })
  },
  kot: {
    list: (params = {}) => request(`/kot?${qs(params)}`),
    sendParcelKot: (payload, idempotencyKey = null) => {
      const headers = {};
      if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
      return request('/kot/parcel', {
        method: 'POST',
        headers,
        body: payload
      });
    },
    verifyParcelDispatch: (payload) =>
      request('/kot/parcel/verify-dispatch', {
        method: 'POST',
        body: payload
      }),
    printKot: (invoiceId, idempotencyKey = null) => {
      const headers = {};
      if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
      return request(`/kot/invoices/${invoiceId}/print-kot`, {
        method: 'POST',
        headers
      });
    },
    reprint: (kotId, reason = 'Kitchen requested reprint') =>
      request(`/kot/tickets/${kotId}/reprint`, {
        method: 'POST',
        body: { reason }
      }),
    getForInvoice: (invoiceId) => request(`/kot/invoices/${invoiceId}`)
  },

  // Restaurant Tables & Floor Management
  tables: {
    list: () => request('/tables'),
    create: (data = {}) => request('/tables', { method: 'POST', body: data }),
    remove: (id) => request(`/tables/${id}`, { method: 'DELETE' }),
    get: (id) => request(`/tables/${id}`),
    open: (id, data = {}) => request(`/tables/${id}/open`, { method: 'POST', body: data }),
    updateItems: (sessionId, items) =>
      request(`/tables/sessions/${sessionId}/items`, { method: 'POST', body: { items } }),
    removeItem: (sessionId, itemId) =>
      request(`/tables/sessions/${sessionId}/items/${itemId}`, { method: 'DELETE' }),
    sendKot: (sessionId, idempotencyKey = null) => {
      const headers = {};
      if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
      return request(`/tables/sessions/${sessionId}/send-kot`, { method: 'POST', headers });
    },
    requestBill: (sessionId) =>
      request(`/tables/sessions/${sessionId}/request-bill`, { method: 'POST' }),
    release: (sessionId) =>
      request(`/tables/sessions/${sessionId}/release`, { method: 'POST' }),
    reopen: (sessionId) =>
      request(`/tables/sessions/${sessionId}/reopen`, { method: 'POST' }),
    checkout: (sessionId, checkoutData = {}, idempotencyKey = null) => {
      const headers = {};
      if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
      return request(`/tables/sessions/${sessionId}/checkout`, {
        method: 'POST',
        headers,
        body: checkoutData
      });
    },
    listKots: (sessionId) => request(`/tables/sessions/${sessionId}/kots`)
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

  // Printers & Android Print Agents
  printers: {
    getBackendUrl: getBackendBaseUrl,
    getDetectedBackendUrl: getDetectedBackendBaseUrl,
    validateBackendUrl: validateBackendUrl,
    saveBackendUrl: (url) => {
      const res = validateBackendUrl(url);
      if (!res.valid) return res;
      try {
        localStorage.setItem(BACKEND_URL_STORAGE_KEY, res.cleanUrl);
      } catch (err) {
        return { valid: false, error: 'Storage access error: ' + err.message };
      }
      return { valid: true, cleanUrl: res.cleanUrl };
    },
    resetBackendUrl: () => {
      try {
        localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
      } catch {}
      return getDetectedBackendBaseUrl();
    },
    storageKey: BACKEND_URL_STORAGE_KEY,
    list: () => request('/printers'),
    create: (data) => request('/printers', { method: 'POST', body: data }),
    update: (id, data) => request(`/printers/${id}`, { method: 'PUT', body: data }),
    testPrint: (id) => request(`/printers/${id}/test-print`, { method: 'POST' }),
    testConnection: (id) => request(`/printers/${id}/test-connection`, { method: 'POST' }),
    getMonitoring: () => request('/printers/monitoring'),
    retryJob: (jobId) => request(`/printers/jobs/${jobId}/retry`, { method: 'POST' }),
    listAgents: () => request('/printers/agents'),
    registerAgent: (data) =>
      request('/printers/agents/register', {
        method: 'POST',
        body: {
          agentCode: data.agentCode || data.agent_code,
          agentName: data.agentName || data.agent_name,
          deviceType: data.deviceType || data.device_type || 'CASHIER_TABLET'
        }
      }),
    rotateAgentCredential: (agentId) =>
      request(`/printers/agents/${agentId}/rotate-credential`, { method: 'POST' }),
    revokeAgent: (agentId) =>
      request(`/printers/agents/${agentId}/revoke`, { method: 'POST' })
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
      return request(`/reports/dashboard?${qs(params)}`);
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
    getBrandWise: (params = {}) => request(`/reports/sales/brand-wise?${qs(params)}`),
    getProductWise: (params = {}) => request(`/reports/sales/product-wise?${qs(params)}`),
    getCategoryWise: (params = {}) => request(`/reports/sales/category-wise?${qs(params)}`),
    getHourly: (date, brandId) => {
      const q = new URLSearchParams({ date: date || '' });
      if (brandId) q.set('brandId', brandId);
      return request(`/reports/sales/hourly?${q.toString()}`);
    },
    getCashierWise: (params = {}) => request(`/reports/cashier-wise?${qs(params)}`),
    getPaymentMethods: (params = {}) => request(`/reports/payments?${qs(params)}`),
    getPayments: (params = {}) => request(`/reports/payments?${qs(params)}`),
    getCashierReconciliation: (params = {}) => request(`/reports/cashier-reconciliation?${qs(params)}`),
    getRefunds: (params = {}) => request(`/reports/refunds?${qs(params)}`),
    getTaxSummary: (params = {}) => request(`/reports/tax-summary?${qs(params)}`),
    getInventory: (locationId = '') => request(`/reports/inventory${locationId ? `?locationId=${locationId}` : ''}`),
    getWastage: (params = {}) => request(`/reports/wastage?${qs(params)}`)
  },

  // Audit Logs (Phase 13)
  audit: {
    list: (params = {}) => request(`/audit-logs?${qs(params)}`)
  },

  // Database Backup & Disaster Recovery (Phase 13)
  backup: {
    list: () => request('/backups'),
    create: () => request('/backups/create', { method: 'POST' }),
    verify: (filename) => request(`/backups/verify/${encodeURIComponent(filename)}`, { method: 'POST' }),
    testRestore: (filename) => request('/backups/restore-test', { method: 'POST', body: { filename } }),
    getDownloadUrl: (filename) => `/api/v1/backups/download/${encodeURIComponent(filename)}`
  }
};
