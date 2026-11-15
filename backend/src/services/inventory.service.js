/**
 * 8it Cafe Cloud POS — Inventory & Stock Management Service
 * Multi-tenant company-scoped inventory, UOM conversions, recipes (BOM),
 * atomic stock movement ledger, stock valuations, physical counts, and sales consumption.
 */

const { pool } = require('../config/database');
const { recordAuditEventTx } = require('./audit.service');

class InventoryError extends Error {
  constructor(message, code = 'INVENTORY_ERROR', statusCode = 400) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Normalizes decimal numeric inputs to string with fixed scale.
 */
function toDecimalString(val, decimals = 4) {
  if (val === undefined || val === null) return Number(0).toFixed(decimals);
  const num = Number(val);
  if (Number.isNaN(num)) {
    throw new InventoryError(`Invalid numeric value: ${val}`, 'INVALID_NUMERIC_VALUE', 400);
  }
  return num.toFixed(decimals);
}

/**
 * Returns default stock location for company, creating one if not present.
 */
async function getDefaultStockLocation(client, companyId) {
  const locRes = await client.query(
    `SELECT id, name, code FROM stock_locations
     WHERE company_id = $1 AND is_default = TRUE AND is_active = TRUE
     LIMIT 1`,
    [companyId]
  );

  if (locRes.rows.length > 0) {
    return locRes.rows[0];
  }

  // Fallback to any active location
  const fallbackRes = await client.query(
    `SELECT id, name, code FROM stock_locations
     WHERE company_id = $1 AND is_active = TRUE
     ORDER BY created_at ASC LIMIT 1`,
    [companyId]
  );

  if (fallbackRes.rows.length > 0) {
    return fallbackRes.rows[0];
  }

  // Create default MAIN_STORE
  const insRes = await client.query(
    `INSERT INTO stock_locations (company_id, name, code, is_default, is_active)
     VALUES ($1, 'Main Store', 'MAIN_STORE', TRUE, TRUE)
     ON CONFLICT (company_id, code) DO UPDATE SET is_active = TRUE
     RETURNING id, name, code`,
    [companyId]
  );
  return insRes.rows[0];
}

// ============================================================================
// 1. UNITS OF MEASUREMENT (UOM)
// ============================================================================

async function listUnitsOfMeasurement(companyId) {
  const res = await pool.query(
    `SELECT id, name, code, base_unit_id, conversion_factor, is_active, created_at
     FROM units_of_measurement
     WHERE company_id = $1
     ORDER BY code ASC`,
    [companyId]
  );
  return res.rows;
}

async function createUnitOfMeasurement(companyId, payload) {
  const { name, code, baseUnitId, conversionFactor } = payload;
  if (!name || !code) {
    throw new InventoryError('Name and code are required for unit of measurement.', 'VALIDATION_ERROR', 400);
  }

  const factor = conversionFactor ? toDecimalString(conversionFactor, 6) : '1.000000';

  const res = await pool.query(
    `INSERT INTO units_of_measurement (company_id, name, code, base_unit_id, conversion_factor)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, code, base_unit_id, conversion_factor, is_active, created_at`,
    [companyId, name.trim(), code.trim().toLowerCase(), baseUnitId || null, factor]
  );
  return res.rows[0];
}

// ============================================================================
// 2. INVENTORY CATEGORIES
// ============================================================================

async function listInventoryCategories(companyId) {
  const res = await pool.query(
    `SELECT id, name, code, description, is_active, created_at
     FROM inventory_categories
     WHERE company_id = $1
     ORDER BY name ASC`,
    [companyId]
  );
  return res.rows;
}

async function createInventoryCategory(companyId, payload) {
  const { name, code, description } = payload;
  if (!name || !code) {
    throw new InventoryError('Name and code are required for inventory category.', 'VALIDATION_ERROR', 400);
  }

  const res = await pool.query(
    `INSERT INTO inventory_categories (company_id, name, code, description)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, code, description, is_active, created_at`,
    [companyId, name.trim(), code.trim().toUpperCase(), description || null]
  );
  return res.rows[0];
}

// ============================================================================
// 3. STOCK LOCATIONS
// ============================================================================

async function listStockLocations(companyId) {
  const res = await pool.query(
    `SELECT id, name, code, is_default, is_active, created_at
     FROM stock_locations
     WHERE company_id = $1
     ORDER BY is_default DESC, name ASC`,
    [companyId]
  );
  return res.rows;
}

async function createStockLocation(companyId, payload) {
  const { name, code, isDefault } = payload;
  if (!name || !code) {
    throw new InventoryError('Name and code are required for stock location.', 'VALIDATION_ERROR', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (isDefault) {
      await client.query(
        'UPDATE stock_locations SET is_default = FALSE WHERE company_id = $1',
        [companyId]
      );
    }

    const res = await client.query(
      `INSERT INTO stock_locations (company_id, name, code, is_default)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, code, is_default, is_active, created_at`,
      [companyId, name.trim(), code.trim().toUpperCase(), Boolean(isDefault)]
    );
    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// 4. INVENTORY ITEMS (CRUD & DEACTIVATION)
// ============================================================================

async function listInventoryItems(companyId, filters = {}) {
  const conditions = ['i.company_id = $1'];
  const params = [companyId];
  let paramIdx = 2;

  if (filters.categoryId) {
    conditions.push(`i.category_id = $${paramIdx++}`);
    params.push(filters.categoryId);
  }
  if (filters.brandId) {
    conditions.push(`i.brand_id = $${paramIdx++}`);
    params.push(filters.brandId);
  }
  if (filters.itemType) {
    conditions.push(`i.item_type = $${paramIdx++}`);
    params.push(filters.itemType);
  }
  if (filters.isActive !== undefined) {
    conditions.push(`i.is_active = $${paramIdx++}`);
    params.push(filters.isActive === 'true' || filters.isActive === true);
  }
  if (filters.search) {
    conditions.push(`(i.name ILIKE $${paramIdx} OR i.sku ILIKE $${paramIdx})`);
    params.push(`%${filters.search}%`);
    paramIdx++;
  }

  const page = parseInt(filters.page || '1', 10);
  const limit = Math.min(parseInt(filters.limit || '50', 10), 100);
  const offset = (page - 1) * limit;

  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM inventory_items i
    WHERE ${conditions.join(' AND ')}
  `;
  const countRes = await pool.query(countQuery, params);
  const total = countRes.rows[0].total;

  const dataQuery = `
    SELECT i.id, i.company_id, i.sku, i.name, i.description, i.item_type,
           i.current_cost, i.reorder_level, i.minimum_stock, i.allow_negative_stock,
           i.is_active, i.created_at, i.updated_at,
           c.name AS category_name, c.code AS category_code,
           u.name AS uom_name, u.code AS uom_code,
           b.name AS brand_name, b.code AS brand_code,
           COALESCE(SUM(sb.quantity_on_hand), 0.0000) AS total_on_hand,
           COALESCE(sb_avg.weighted_avg_cost, i.current_cost) AS valuation_cost
    FROM inventory_items i
    LEFT JOIN inventory_categories c ON i.category_id = c.id
    JOIN units_of_measurement u ON i.uom_id = u.id
    LEFT JOIN brands b ON i.brand_id = b.id
    LEFT JOIN stock_balances sb ON sb.inventory_item_id = i.id
    LEFT JOIN (
      SELECT inventory_item_id,
             CASE WHEN SUM(quantity_on_hand) > 0
                  THEN SUM(quantity_on_hand * average_cost) / SUM(quantity_on_hand)
                  ELSE AVG(average_cost)
             END AS weighted_avg_cost
      FROM stock_balances
      GROUP BY inventory_item_id
    ) sb_avg ON sb_avg.inventory_item_id = i.id
    WHERE ${conditions.join(' AND ')}
    GROUP BY i.id, c.name, c.code, u.name, u.code, b.name, b.code, sb_avg.weighted_avg_cost
    ORDER BY i.name ASC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `;
  params.push(limit, offset);

  const dataRes = await pool.query(dataQuery, params);

  return {
    items: dataRes.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

async function getInventoryItemById(companyId, itemId) {
  const res = await pool.query(
    `SELECT i.id, i.company_id, i.category_id, i.uom_id, i.brand_id,
            i.sku, i.name, i.description, i.item_type,
            i.current_cost, i.reorder_level, i.minimum_stock,
            i.allow_negative_stock, i.is_active, i.created_at, i.updated_at,
            c.name AS category_name, c.code AS category_code,
            u.name AS uom_name, u.code AS uom_code,
            b.name AS brand_name, b.code AS brand_code,
            COALESCE(sb.quantity_on_hand, 0.0000) AS quantity_on_hand,
            COALESCE(sb.average_cost, i.current_cost) AS average_cost
     FROM inventory_items i
     LEFT JOIN inventory_categories c ON i.category_id = c.id
     JOIN units_of_measurement u ON i.uom_id = u.id
     LEFT JOIN brands b ON i.brand_id = b.id
     LEFT JOIN (
       SELECT inventory_item_id,
              SUM(quantity_on_hand) AS quantity_on_hand,
              AVG(average_cost) AS average_cost
       FROM stock_balances
       WHERE company_id = $1
       GROUP BY inventory_item_id
     ) sb ON sb.inventory_item_id = i.id
     WHERE i.id = $2 AND i.company_id = $1`,
    [companyId, itemId]
  );

  if (res.rows.length === 0) {
    throw new InventoryError('Inventory item not found.', 'NOT_FOUND', 404);
  }
  return res.rows[0];
}

async function createInventoryItem(companyId, userId, payload) {
  const {
    categoryId, uomId, brandId, sku, name, description,
    itemType, currentCost, reorderLevel, minimumStock,
    allowNegativeStock, initialStock, locationId
  } = payload;

  if (!sku || !name || !uomId || !itemType) {
    throw new InventoryError('SKU, name, uomId, and itemType are required.', 'VALIDATION_ERROR', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify UOM belongs to company
    const uomRes = await client.query(
      'SELECT id FROM units_of_measurement WHERE id = $1 AND company_id = $2',
      [uomId, companyId]
    );
    if (uomRes.rows.length === 0) {
      throw new InventoryError('Specified UOM not found under company.', 'INVALID_UOM', 404);
    }

    // Verify Category if specified
    if (categoryId) {
      const catRes = await client.query(
        'SELECT id FROM inventory_categories WHERE id = $1 AND company_id = $2',
        [categoryId, companyId]
      );
      if (catRes.rows.length === 0) {
        throw new InventoryError('Specified inventory category not found.', 'INVALID_CATEGORY', 404);
      }
    }

    // Verify Brand if specified
    if (brandId) {
      const brandRes = await client.query(
        'SELECT id FROM brands WHERE id = $1 AND company_id = $2',
        [brandId, companyId]
      );
      if (brandRes.rows.length === 0) {
        throw new InventoryError('Specified brand not found.', 'INVALID_BRAND', 404);
      }
    }

    const insRes = await client.query(
      `INSERT INTO inventory_items (
         company_id, category_id, uom_id, brand_id, sku, name,
         description, item_type, current_cost, reorder_level,
         minimum_stock, allow_negative_stock
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        companyId, categoryId || null, uomId, brandId || null,
        sku.trim().toUpperCase(), name.trim(), description || null,
        itemType, toDecimalString(currentCost || 0, 4),
        toDecimalString(reorderLevel || 0, 4),
        toDecimalString(minimumStock || 0, 4),
        Boolean(allowNegativeStock)
      ]
    );

    const item = insRes.rows[0];

    // Record initial opening stock if requested
    if (initialStock && Number(initialStock) > 0) {
      const loc = locationId
        ? { id: locationId }
        : await getDefaultStockLocation(client, companyId);

      await recordStockMovementTx(client, {
        companyId,
        inventoryItemId: item.id,
        locationId: loc.id,
        movementType: 'OPENING_STOCK',
        quantity: toDecimalString(initialStock, 4),
        unitCost: item.current_cost,
        sourceType: 'OPENING_BALANCE',
        sourceId: item.id,
        sourceReference: `INIT-${item.sku}`,
        userId,
        reason: 'Initial opening stock entry upon item creation'
      });
    }

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'INVENTORY_ITEM_CREATED',
      entityType: 'INVENTORY_ITEM',
      entityId: item.id,
      newValues: { sku: item.sku, name: item.name, item_type: item.item_type }
    });

    await client.query('COMMIT');
    return item;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      throw new InventoryError(`Item with SKU "${payload.sku}" already exists.`, 'DUPLICATE_SKU', 409);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function updateInventoryItem(companyId, userId, itemId, payload) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const curRes = await client.query(
      'SELECT * FROM inventory_items WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [itemId, companyId]
    );
    if (curRes.rows.length === 0) {
      throw new InventoryError('Inventory item not found.', 'NOT_FOUND', 404);
    }
    const current = curRes.rows[0];

    const name = payload.name !== undefined ? payload.name.trim() : current.name;
    const categoryId = payload.categoryId !== undefined ? payload.categoryId : current.category_id;
    const brandId = payload.brandId !== undefined ? payload.brandId : current.brand_id;
    const description = payload.description !== undefined ? payload.description : current.description;
    const currentCost = payload.currentCost !== undefined ? toDecimalString(payload.currentCost, 4) : current.current_cost;
    const reorderLevel = payload.reorderLevel !== undefined ? toDecimalString(payload.reorderLevel, 4) : current.reorder_level;
    const minimumStock = payload.minimumStock !== undefined ? toDecimalString(payload.minimumStock, 4) : current.minimum_stock;
    const allowNegativeStock = payload.allowNegativeStock !== undefined ? Boolean(payload.allowNegativeStock) : current.allow_negative_stock;

    const upRes = await client.query(
      `UPDATE inventory_items
       SET name = $1, category_id = $2, brand_id = $3, description = $4,
           current_cost = $5, reorder_level = $6, minimum_stock = $7,
           allow_negative_stock = $8, updated_at = clock_timestamp()
       WHERE id = $9 AND company_id = $10
       RETURNING *`,
      [
        name, categoryId, brandId, description,
        currentCost, reorderLevel, minimumStock,
        allowNegativeStock, itemId, companyId
      ]
    );

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'INVENTORY_ITEM_UPDATED',
      entityType: 'INVENTORY_ITEM',
      entityId: itemId,
      newValues: { name, currentCost, reorderLevel, minimumStock }
    });

    await client.query('COMMIT');
    return upRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function toggleInventoryItemActive(companyId, userId, itemId, isActive) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE inventory_items
       SET is_active = $1, updated_at = clock_timestamp()
       WHERE id = $2 AND company_id = $3
       RETURNING id, sku, name, is_active`,
      [Boolean(isActive), itemId, companyId]
    );

    if (res.rows.length === 0) {
      throw new InventoryError('Inventory item not found.', 'NOT_FOUND', 404);
    }

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: isActive ? 'INVENTORY_ITEM_ACTIVATED' : 'INVENTORY_ITEM_DEACTIVATED',
      entityType: 'INVENTORY_ITEM',
      entityId: itemId,
      newValues: { is_active: Boolean(isActive) }
    });

    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// 5. PRODUCT TO INVENTORY MAPPING (PACKAGED GOODS)
// ============================================================================

async function mapProductToInventoryItem(companyId, userId, payload) {
  const { productId, inventoryItemId, quantityMultiplier } = payload;
  if (!productId || !inventoryItemId) {
    throw new InventoryError('productId and inventoryItemId are required.', 'VALIDATION_ERROR', 400);
  }

  const multiplier = quantityMultiplier ? toDecimalString(quantityMultiplier, 4) : '1.0000';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify product belongs to company
    const prodRes = await client.query(
      'SELECT id, name FROM products WHERE id = $1 AND company_id = $2',
      [productId, companyId]
    );
    if (prodRes.rows.length === 0) {
      throw new InventoryError('Product not found under company.', 'INVALID_PRODUCT', 404);
    }

    // Verify inventory item belongs to company
    const itemRes = await client.query(
      'SELECT id, sku, name FROM inventory_items WHERE id = $1 AND company_id = $2',
      [inventoryItemId, companyId]
    );
    if (itemRes.rows.length === 0) {
      throw new InventoryError('Inventory item not found under company.', 'INVALID_ITEM', 404);
    }

    const res = await client.query(
      `INSERT INTO product_inventory_mappings (company_id, product_id, inventory_item_id, quantity_multiplier, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (company_id, product_id)
       DO UPDATE SET inventory_item_id = EXCLUDED.inventory_item_id,
                     quantity_multiplier = EXCLUDED.quantity_multiplier,
                     is_active = TRUE,
                     updated_at = clock_timestamp()
       RETURNING *`,
      [companyId, productId, inventoryItemId, multiplier]
    );

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'PRODUCT_INVENTORY_MAPPED',
      entityType: 'PRODUCT_MAPPING',
      entityId: res.rows[0].id,
      newValues: { productId, inventoryItemId, multiplier }
    });

    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getProductInventoryMapping(companyId, productId) {
  const res = await pool.query(
    `SELECT m.id, m.company_id, m.product_id, m.inventory_item_id,
            m.quantity_multiplier, m.is_active,
            p.name AS product_name, p.sku AS product_sku,
            i.name AS item_name, i.sku AS item_sku,
            u.code AS uom_code
     FROM product_inventory_mappings m
     JOIN products p ON m.product_id = p.id
     JOIN inventory_items i ON m.inventory_item_id = i.id
     JOIN units_of_measurement u ON i.uom_id = u.id
     WHERE m.product_id = $1 AND m.company_id = $2`,
    [productId, companyId]
  );
  return res.rows.length > 0 ? res.rows[0] : null;
}

// ============================================================================
// 6. PRODUCT RECIPES (BOM FOR PREPARED GOODS)
// ============================================================================

async function createOrUpdateProductRecipe(companyId, userId, payload) {
  const { productId, yieldQuantity, yieldUnit, instructions, components } = payload;
  if (!productId || !components || !Array.isArray(components) || components.length === 0) {
    throw new InventoryError('productId and a non-empty components array are required.', 'VALIDATION_ERROR', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify product
    const prodRes = await client.query(
      'SELECT id, name FROM products WHERE id = $1 AND company_id = $2',
      [productId, companyId]
    );
    if (prodRes.rows.length === 0) {
      throw new InventoryError('Product not found under company.', 'INVALID_PRODUCT', 404);
    }

    // Find latest recipe version
    const latestRes = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS max_version
       FROM product_recipes
       WHERE company_id = $1 AND product_id = $2`,
      [companyId, productId]
    );
    const nextVersion = latestRes.rows[0].max_version + 1;

    // Deactivate previous active recipes
    await client.query(
      `UPDATE product_recipes
       SET is_active = FALSE, updated_at = clock_timestamp()
       WHERE company_id = $1 AND product_id = $2`,
      [companyId, productId]
    );

    // Insert new active recipe version
    const recRes = await client.query(
      `INSERT INTO product_recipes (
         company_id, product_id, version, yield_quantity, yield_unit, instructions, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING *`,
      [
        companyId, productId, nextVersion,
        toDecimalString(yieldQuantity || 1, 4),
        yieldUnit || 'portion',
        instructions || null
      ]
    );
    const recipe = recRes.rows[0];

    // Insert components
    const componentRows = [];
    for (const comp of components) {
      if (!comp.inventoryItemId || !comp.quantity) {
        throw new InventoryError('Each component requires inventoryItemId and quantity.', 'VALIDATION_ERROR', 400);
      }

      // Check item and its UOM
      const itemRes = await client.query(
        'SELECT id, uom_id, current_cost, name FROM inventory_items WHERE id = $1 AND company_id = $2',
        [comp.inventoryItemId, companyId]
      );
      if (itemRes.rows.length === 0) {
        throw new InventoryError(`Component inventory item "${comp.inventoryItemId}" not found.`, 'INVALID_ITEM', 404);
      }
      const item = itemRes.rows[0];
      const uomId = comp.uomId || item.uom_id;

      const cRes = await client.query(
        `INSERT INTO recipe_components (company_id, recipe_id, inventory_item_id, quantity, uom_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [companyId, recipe.id, item.id, toDecimalString(comp.quantity, 6), uomId, comp.notes || null]
      );
      componentRows.push({ ...cRes.rows[0], item_name: item.name });
    }

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'RECIPE_VERSION_CREATED',
      entityType: 'PRODUCT_RECIPE',
      entityId: recipe.id,
      newValues: { productId, version: nextVersion, componentCount: componentRows.length }
    });

    await client.query('COMMIT');
    return { ...recipe, components: componentRows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getProductRecipe(companyId, productId, version = null) {
  const versionClause = version ? 'AND r.version = $3' : 'AND r.is_active = TRUE';
  const params = [companyId, productId];
  if (version) params.push(version);

  const recRes = await pool.query(
    `SELECT r.*, p.name AS product_name, p.sku AS product_sku
     FROM product_recipes r
     JOIN products p ON r.product_id = p.id
     WHERE r.company_id = $1 AND r.product_id = $2 ${versionClause}
     ORDER BY r.version DESC
     LIMIT 1`,
    params
  );

  if (recRes.rows.length === 0) {
    return null;
  }

  const recipe = recRes.rows[0];

  const compRes = await pool.query(
    `SELECT rc.id, rc.inventory_item_id, rc.quantity, rc.uom_id, rc.notes,
            i.name AS item_name, i.sku AS item_sku, i.current_cost,
            u.name AS uom_name, u.code AS uom_code,
            COALESCE(sb.quantity_on_hand, 0.0000) AS available_stock,
            (rc.quantity * i.current_cost) AS estimated_component_cost
     FROM recipe_components rc
     JOIN inventory_items i ON rc.inventory_item_id = i.id
     JOIN units_of_measurement u ON rc.uom_id = u.id
     LEFT JOIN (
       SELECT inventory_item_id, SUM(quantity_on_hand) AS quantity_on_hand
       FROM stock_balances
       WHERE company_id = $1
       GROUP BY inventory_item_id
     ) sb ON sb.inventory_item_id = i.id
     WHERE rc.recipe_id = $2
     ORDER BY i.name ASC`,
    [companyId, recipe.id]
  );

  const components = compRes.rows;
  const totalRecipeCost = components.reduce(
    (sum, c) => sum + Number(c.estimated_component_cost || 0),
    0
  );

  return {
    ...recipe,
    components,
    estimatedTotalCost: totalRecipeCost.toFixed(4)
  };
}

// ============================================================================
// 7. STOCK MOVEMENT ENGINE (ATOMIC LEDGER & BALANCES)
// ============================================================================

/**
 * Low-level transactional helper to update stock balances and append to ledger.
 * Manages moving average cost and negative balance protection.
 */
async function recordStockMovementTx(client, {
  companyId,
  inventoryItemId,
  locationId,
  movementType,
  quantity,
  unitCost = 0,
  sourceType = null,
  sourceId = null,
  sourceReference = null,
  recipeId = null,
  recipeVersion = null,
  userId = null,
  reason = null,
  notes = null
}) {
  const qtyNum = Number(quantity);
  const costNum = Number(unitCost);

  // 1. Lock or initialize stock_balances row
  const balRes = await client.query(
    `SELECT id, quantity_on_hand, average_cost
     FROM stock_balances
     WHERE company_id = $1 AND inventory_item_id = $2 AND location_id = $3
     FOR UPDATE`,
    [companyId, inventoryItemId, locationId]
  );

  let currentQty = 0;
  let currentAvgCost = costNum;

  if (balRes.rows.length === 0) {
    const initRes = await client.query(
      `INSERT INTO stock_balances (
         company_id, inventory_item_id, location_id, quantity_on_hand, average_cost
       ) VALUES ($1, $2, $3, 0.0000, $4)
       RETURNING id, quantity_on_hand, average_cost`,
      [companyId, inventoryItemId, locationId, toDecimalString(costNum, 4)]
    );
    currentQty = 0;
    currentAvgCost = costNum;
  } else {
    currentQty = Number(balRes.rows[0].quantity_on_hand);
    currentAvgCost = Number(balRes.rows[0].average_cost);
  }

  const newQty = currentQty + qtyNum;

  // 2. Moving Average Cost Calculation for inbound stock (increases)
  let newAvgCost = currentAvgCost;
  if (qtyNum > 0 && costNum > 0) {
    if (currentQty <= 0) {
      newAvgCost = costNum;
    } else {
      const totalCurrentValuation = currentQty * currentAvgCost;
      const totalIncomingValuation = qtyNum * costNum;
      newAvgCost = (totalCurrentValuation + totalIncomingValuation) / newQty;
    }
  }

  // 3. Update stock_balances (trigger fn_stock_balances_check_negative guards against unauthorized negative balance)
  await client.query(
    `UPDATE stock_balances
     SET quantity_on_hand = $1,
         average_cost = $2,
         updated_at = clock_timestamp()
     WHERE company_id = $3 AND inventory_item_id = $4 AND location_id = $5`,
    [
      toDecimalString(newQty, 4),
      toDecimalString(newAvgCost, 4),
      companyId,
      inventoryItemId,
      locationId
    ]
  );

  // 4. Append immutable ledger row
  const totalCost = Math.abs(qtyNum) * (costNum > 0 ? costNum : currentAvgCost);

  const ledRes = await client.query(
    `INSERT INTO stock_movement_ledger (
       company_id, inventory_item_id, location_id, movement_type,
       quantity, balance_after, unit_cost, total_cost,
       source_type, source_id, source_reference,
       recipe_id, recipe_version, created_by, reason, notes
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11,
       $12, $13, $14, $15, $16
     ) RETURNING *`,
    [
      companyId, inventoryItemId, locationId, movementType,
      toDecimalString(qtyNum, 4),
      toDecimalString(newQty, 4),
      toDecimalString(costNum > 0 ? costNum : currentAvgCost, 4),
      toDecimalString(totalCost, 4),
      sourceType, sourceId, sourceReference,
      recipeId, recipeVersion, userId, reason, notes
    ]
  );

  return ledRes.rows[0];
}

// ============================================================================
// 8. STOCK OPERATIONS: OPENING, RECEIPTS, ADJUSTMENTS, WASTAGE
// ============================================================================

async function setOpeningStock(companyId, userId, payload) {
  const { inventoryItemId, locationId, quantity, unitCost, notes } = payload;
  if (!inventoryItemId || quantity === undefined) {
    throw new InventoryError('inventoryItemId and quantity are required.', 'VALIDATION_ERROR', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loc = locationId
      ? { id: locationId }
      : await getDefaultStockLocation(client, companyId);

    const mov = await recordStockMovementTx(client, {
      companyId,
      inventoryItemId,
      locationId: loc.id,
      movementType: 'OPENING_STOCK',
      quantity: toDecimalString(quantity, 4),
      unitCost: unitCost || 0,
      sourceType: 'OPENING_BALANCE',
      sourceId: inventoryItemId,
      sourceReference: 'OPENING-STOCK',
      userId,
      reason: 'Opening stock entry',
      notes
    });

    await client.query('COMMIT');
    return mov;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function receivePurchaseStock(companyId, userId, payload) {
  const { locationId, items, supplierReference, notes } = payload;
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new InventoryError('items array is required for stock receipt.', 'VALIDATION_ERROR', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loc = locationId
      ? { id: locationId }
      : await getDefaultStockLocation(client, companyId);

    const movements = [];
    for (const item of items) {
      if (!item.inventoryItemId || !item.quantity || Number(item.quantity) <= 0) {
        throw new InventoryError('Valid inventoryItemId and positive quantity required.', 'VALIDATION_ERROR', 400);
      }

      const mov = await recordStockMovementTx(client, {
        companyId,
        inventoryItemId: item.inventoryItemId,
        locationId: loc.id,
        movementType: 'PURCHASE_RECEIPT',
        quantity: toDecimalString(item.quantity, 4),
        unitCost: item.unitCost || 0,
        sourceType: 'PURCHASE_RECEIPT',
        sourceId: null,
        sourceReference: supplierReference || 'MANUAL-RECEIPT',
        userId,
        reason: 'Purchase / manual stock receipt',
        notes: item.notes || notes
      });
      movements.push(mov);
    }

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'STOCK_PURCHASE_RECEIVED',
      entityType: 'STOCK_RECEIPT',
      entityId: loc.id,
      newValues: { count: movements.length, reference: supplierReference }
    });

    await client.query('COMMIT');
    return movements;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createStockAdjustment(companyId, userId, payload) {
  const { locationId, adjustmentType, reason, items, notes } = payload;
  if (!adjustmentType || !reason || !items || !Array.isArray(items) || items.length === 0) {
    throw new InventoryError('adjustmentType, reason, and items array are required.', 'VALIDATION_ERROR', 400);
  }

  const validTypes = ['INCREASE', 'DECREASE', 'WASTAGE', 'RETURN_RESTOCK'];
  if (!validTypes.includes(adjustmentType)) {
    throw new InventoryError(`Invalid adjustmentType: ${adjustmentType}`, 'INVALID_ADJUSTMENT_TYPE', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loc = locationId
      ? { id: locationId }
      : await getDefaultStockLocation(client, companyId);

    // Create adjustment header
    const adjRes = await client.query(
      `INSERT INTO stock_adjustments (company_id, location_id, adjustment_type, reason, created_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [companyId, loc.id, adjustmentType, reason.trim(), userId, notes || null]
    );
    const adjustment = adjRes.rows[0];

    const isNegativeDelta = adjustmentType === 'DECREASE' || adjustmentType === 'WASTAGE';
    const movementType = adjustmentType === 'WASTAGE' ? 'WASTAGE' :
                         adjustmentType === 'RETURN_RESTOCK' ? 'RETURN_RESTOCK' :
                         adjustmentType === 'INCREASE' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';

    const adjItems = [];
    for (const it of items) {
      if (!it.inventoryItemId || it.quantity === undefined || Number(it.quantity) <= 0) {
        throw new InventoryError('Each item requires inventoryItemId and positive quantity.', 'VALIDATION_ERROR', 400);
      }

      // Record adjustment item row
      const itRes = await client.query(
        `INSERT INTO stock_adjustment_items (company_id, adjustment_id, inventory_item_id, quantity, unit_cost, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [companyId, adjustment.id, it.inventoryItemId, toDecimalString(it.quantity, 4), toDecimalString(it.unitCost || 0, 4), it.notes || null]
      );
      adjItems.push(itRes.rows[0]);

      // Signed delta
      const signedQty = isNegativeDelta ? -Math.abs(Number(it.quantity)) : Math.abs(Number(it.quantity));

      await recordStockMovementTx(client, {
        companyId,
        inventoryItemId: it.inventoryItemId,
        locationId: loc.id,
        movementType,
        quantity: toDecimalString(signedQty, 4),
        unitCost: it.unitCost || 0,
        sourceType: 'STOCK_ADJUSTMENT',
        sourceId: adjustment.id,
        sourceReference: `ADJ-${adjustment.id.substring(0, 8)}`,
        userId,
        reason,
        notes: it.notes || notes
      });
    }

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: `STOCK_ADJUSTMENT_${adjustmentType}`,
      entityType: 'STOCK_ADJUSTMENT',
      entityId: adjustment.id,
      newValues: { type: adjustmentType, reason, itemCount: adjItems.length }
    });

    await client.query('COMMIT');
    return { ...adjustment, items: adjItems };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// 9. PHYSICAL STOCK COUNT & RECONCILIATION
// ============================================================================

async function startStockCountSession(companyId, userId, payload) {
  const { locationId, notes } = payload;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loc = locationId
      ? { id: locationId }
      : await getDefaultStockLocation(client, companyId);

    const sessionCode = `COUNT-${Date.now().toString(36).toUpperCase()}`;

    const sessRes = await client.query(
      `INSERT INTO stock_count_sessions (company_id, location_id, session_code, created_by, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [companyId, loc.id, sessionCode, userId, notes || null]
    );
    const session = sessRes.rows[0];

    // Snapshot all active inventory items and current balance
    const itemsRes = await client.query(
      `SELECT i.id, i.current_cost,
              COALESCE(sb.quantity_on_hand, 0.0000) AS system_quantity,
              COALESCE(sb.average_cost, i.current_cost) AS unit_cost
       FROM inventory_items i
       LEFT JOIN stock_balances sb ON sb.inventory_item_id = i.id AND sb.location_id = $2
       WHERE i.company_id = $1 AND i.is_active = TRUE`,
      [companyId, loc.id]
    );

    const lineRows = [];
    for (const item of itemsRes.rows) {
      const lRes = await client.query(
        `INSERT INTO stock_count_lines (
           company_id, session_id, inventory_item_id, system_quantity, counted_quantity, unit_cost
         ) VALUES ($1, $2, $3, $4, $4, $5)
         RETURNING *`,
        [companyId, session.id, item.id, item.system_quantity, item.unit_cost]
      );
      lineRows.push(lRes.rows[0]);
    }

    await client.query('COMMIT');
    return { ...session, lines: lineRows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateStockCountLine(companyId, userId, sessionId, linePayload) {
  const { inventoryItemId, countedQuantity, notes } = linePayload;
  if (!inventoryItemId || countedQuantity === undefined) {
    throw new InventoryError('inventoryItemId and countedQuantity are required.', 'VALIDATION_ERROR', 400);
  }

  const res = await pool.query(
    `UPDATE stock_count_lines
     SET counted_quantity = $1, notes = $2
     WHERE session_id = $3 AND inventory_item_id = $4 AND company_id = $5
     RETURNING *`,
    [toDecimalString(countedQuantity, 4), notes || null, sessionId, inventoryItemId, companyId]
  );

  if (res.rows.length === 0) {
    throw new InventoryError('Stock count line not found.', 'NOT_FOUND', 404);
  }
  return res.rows[0];
}

async function reconcileStockCountSession(companyId, userId, sessionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sessRes = await client.query(
      `SELECT * FROM stock_count_sessions
       WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [sessionId, companyId]
    );
    if (sessRes.rows.length === 0) {
      throw new InventoryError('Stock count session not found.', 'NOT_FOUND', 404);
    }
    const session = sessRes.rows[0];
    if (session.status !== 'IN_PROGRESS') {
      throw new InventoryError(`Session cannot be reconciled in status "${session.status}".`, 'INVALID_SESSION_STATUS', 400);
    }

    const linesRes = await client.query(
      `SELECT scl.*, i.sku, i.name
       FROM stock_count_lines scl
       JOIN inventory_items i ON scl.inventory_item_id = i.id
       WHERE scl.session_id = $1 AND scl.company_id = $2`,
      [sessionId, companyId]
    );

    const reconciledMovements = [];
    for (const line of linesRes.rows) {
      const discrepancy = Number(line.discrepancy_quantity);
      if (discrepancy !== 0) {
        const mov = await recordStockMovementTx(client, {
          companyId,
          inventoryItemId: line.inventory_item_id,
          locationId: session.location_id,
          movementType: 'STOCK_COUNT',
          quantity: toDecimalString(discrepancy, 4),
          unitCost: line.unit_cost,
          sourceType: 'STOCK_COUNT',
          sourceId: session.id,
          sourceReference: session.session_code,
          userId,
          reason: `Physical count reconciliation (${session.session_code}): Discrepancy ${discrepancy >= 0 ? '+' : ''}${discrepancy}`
        });
        reconciledMovements.push(mov);
      }
    }

    await client.query(
      `UPDATE stock_count_sessions
       SET status = 'RECONCILED', reconciled_by = $1, reconciled_at = clock_timestamp()
       WHERE id = $2 AND company_id = $3`,
      [userId, sessionId, companyId]
    );

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'STOCK_COUNT_RECONCILED',
      entityType: 'STOCK_COUNT_SESSION',
      entityId: sessionId,
      newValues: { sessionCode: session.session_code, adjustmentsApplied: reconciledMovements.length }
    });

    await client.query('COMMIT');
    return {
      success: true,
      sessionId,
      sessionCode: session.session_code,
      status: 'RECONCILED',
      discrepancyCount: reconciledMovements.length,
      movements: reconciledMovements
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// 10. STOCK TRANSFERS
// ============================================================================

async function createStockTransfer(companyId, userId, payload) {
  const { sourceLocationId, destinationLocationId, items, notes } = payload;
  if (!sourceLocationId || !destinationLocationId || !items || !Array.isArray(items) || items.length === 0) {
    throw new InventoryError('sourceLocationId, destinationLocationId, and items array are required.', 'VALIDATION_ERROR', 400);
  }
  if (sourceLocationId === destinationLocationId) {
    throw new InventoryError('Source and destination locations cannot be identical.', 'INVALID_TRANSFER_LOCATIONS', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const transferNumber = `TRF-${Date.now().toString(36).toUpperCase()}`;

    const trfRes = await client.query(
      `INSERT INTO stock_transfers (
         company_id, transfer_number, source_location_id, destination_location_id, created_by, notes
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [companyId, transferNumber, sourceLocationId, destinationLocationId, userId, notes || null]
    );
    const transfer = trfRes.rows[0];

    const transferItems = [];
    for (const it of items) {
      if (!it.inventoryItemId || !it.quantity || Number(it.quantity) <= 0) {
        throw new InventoryError('Each item requires inventoryItemId and positive quantity.', 'VALIDATION_ERROR', 400);
      }

      // Insert item
      const itemRes = await client.query(
        `INSERT INTO stock_transfer_items (company_id, transfer_id, inventory_item_id, quantity, unit_cost)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [companyId, transfer.id, it.inventoryItemId, toDecimalString(it.quantity, 4), toDecimalString(it.unitCost || 0, 4)]
      );
      transferItems.push(itemRes.rows[0]);

      // Deduct from source
      await recordStockMovementTx(client, {
        companyId,
        inventoryItemId: it.inventoryItemId,
        locationId: sourceLocationId,
        movementType: 'TRANSFER_OUT',
        quantity: toDecimalString(-Math.abs(Number(it.quantity)), 4),
        unitCost: it.unitCost || 0,
        sourceType: 'STOCK_TRANSFER',
        sourceId: transfer.id,
        sourceReference: transferNumber,
        userId,
        reason: `Transfer to destination location`
      });

      // Add to destination
      await recordStockMovementTx(client, {
        companyId,
        inventoryItemId: it.inventoryItemId,
        locationId: destinationLocationId,
        movementType: 'TRANSFER_IN',
        quantity: toDecimalString(Math.abs(Number(it.quantity)), 4),
        unitCost: it.unitCost || 0,
        sourceType: 'STOCK_TRANSFER',
        sourceId: transfer.id,
        sourceReference: transferNumber,
        userId,
        reason: `Transfer from source location`
      });
    }

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'STOCK_TRANSFER_COMPLETED',
      entityType: 'STOCK_TRANSFER',
      entityId: transfer.id,
      newValues: { transferNumber, itemCount: transferItems.length }
    });

    await client.query('COMMIT');
    return { ...transfer, items: transferItems };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// 11. SALES CONSUMPTION (INTEGRATION WITH BILLING SETTLEMENT)
// ============================================================================

/**
 * Transactionally deducts inventory for a paid invoice.
 * Called inside checkoutInvoiceTx in the same client transaction.
 * Supports:
 *   1. Packaged products (product_inventory_mappings)
 *   2. Prepared products (product_recipes & recipe_components)
 * Strict stock checking: rolls back transaction if any ingredient/item has insufficient stock.
 */
async function consumeStockForInvoiceTx(client, { companyId, invoiceId, userId }) {
  // Idempotency: verify if stock was already consumed for this invoice
  const existingMov = await client.query(
    `SELECT id FROM stock_movement_ledger
     WHERE company_id = $1 AND source_type = 'INVOICE' AND source_id = $2
     LIMIT 1`,
    [companyId, invoiceId]
  );
  if (existingMov.rows.length > 0) {
    // Already consumed (idempotent replay)
    return { consumed: false, reason: 'ALREADY_CONSUMED' };
  }

  // Fetch invoice details and items
  const invRes = await client.query(
    'SELECT invoice_number FROM invoices WHERE id = $1 AND company_id = $2',
    [invoiceId, companyId]
  );
  if (invRes.rows.length === 0) {
    throw new InventoryError('Invoice not found.', 'NOT_FOUND', 404);
  }
  const invoiceNumber = invRes.rows[0].invoice_number;

  const itemsRes = await client.query(
    `SELECT id, product_id, quantity, item_name_snapshot, brand_name_snapshot
     FROM invoice_items
     WHERE invoice_id = $1 AND company_id = $2`,
    [invoiceId, companyId]
  );

  const defaultLoc = await getDefaultStockLocation(client, companyId);

  // Collect all stock requirements before deducting
  // Key: inventoryItemId, Value: { item, requiredQty }
  const deductions = [];

  for (const item of itemsRes.rows) {
    const soldQty = Number(item.quantity);

    // 1. Check direct product inventory mapping (packaged good)
    const mapRes = await client.query(
      `SELECT m.inventory_item_id, m.quantity_multiplier, i.sku, i.name, i.allow_negative_stock
       FROM product_inventory_mappings m
       JOIN inventory_items i ON m.inventory_item_id = i.id
       WHERE m.product_id = $1 AND m.company_id = $2 AND m.is_active = TRUE`,
      [item.product_id, companyId]
    );

    if (mapRes.rows.length > 0) {
      const map = mapRes.rows[0];
      const requiredQty = soldQty * Number(map.quantity_multiplier);
      deductions.push({
        inventoryItemId: map.inventory_item_id,
        sku: map.sku,
        name: map.name,
        allowNegative: map.allow_negative_stock,
        quantity: requiredQty,
        sourceType: 'INVOICE',
        sourceId: invoiceId,
        sourceReference: invoiceNumber,
        recipeId: null,
        recipeVersion: null,
        reason: `Sale of ${item.item_name_snapshot} (Qty: ${soldQty})`
      });
      continue;
    }

    // 2. Check recipe (prepared goods)
    const recRes = await client.query(
      `SELECT r.id AS recipe_id, r.version, r.yield_quantity,
              rc.inventory_item_id, rc.quantity AS component_quantity,
              i.sku, i.name, i.allow_negative_stock
       FROM product_recipes r
       JOIN recipe_components rc ON rc.recipe_id = r.id
       JOIN inventory_items i ON rc.inventory_item_id = i.id
       WHERE r.product_id = $1 AND r.company_id = $2 AND r.is_active = TRUE`,
      [item.product_id, companyId]
    );

    if (recRes.rows.length > 0) {
      for (const row of recRes.rows) {
        const yieldQty = Number(row.yield_quantity || 1);
        const compQty = Number(row.component_quantity);
        const requiredQty = (soldQty * compQty) / yieldQty;

        deductions.push({
          inventoryItemId: row.inventory_item_id,
          sku: row.sku,
          name: row.name,
          allowNegative: row.allow_negative_stock,
          quantity: requiredQty,
          sourceType: 'INVOICE',
          sourceId: invoiceId,
          sourceReference: invoiceNumber,
          recipeId: row.recipe_id,
          recipeVersion: row.version,
          reason: `Recipe consumption for ${item.item_name_snapshot} (Qty: ${soldQty})`
        });
      }
    }
  }

  // Preflight check: verify all deductions have sufficient stock
  for (const d of deductions) {
    if (!d.allowNegative) {
      const balRes = await client.query(
        `SELECT COALESCE(quantity_on_hand, 0) AS on_hand
         FROM stock_balances
         WHERE company_id = $1 AND inventory_item_id = $2 AND location_id = $3
         FOR UPDATE`,
        [companyId, d.inventoryItemId, defaultLoc.id]
      );

      const onHand = balRes.rows.length > 0 ? Number(balRes.rows[0].on_hand) : 0;
      if (onHand < d.quantity) {
        throw new InventoryError(
          `INSUFFICIENT_STOCK: Item "${d.name}" (SKU: ${d.sku}) has insufficient stock. Available: ${onHand.toFixed(2)}, Required: ${d.quantity.toFixed(2)}.`,
          'INSUFFICIENT_STOCK',
          400
        );
      }
    }
  }

  // Execute all stock movements
  const postedMovements = [];
  for (const d of deductions) {
    const mov = await recordStockMovementTx(client, {
      companyId,
      inventoryItemId: d.inventoryItemId,
      locationId: defaultLoc.id,
      movementType: 'SALE',
      quantity: toDecimalString(-Math.abs(d.quantity), 4),
      sourceType: d.sourceType,
      sourceId: d.sourceId,
      sourceReference: d.sourceReference,
      recipeId: d.recipeId,
      recipeVersion: d.recipeVersion,
      userId,
      reason: d.reason
    });
    postedMovements.push(mov);
  }

  return { consumed: true, count: postedMovements.length, movements: postedMovements };
}

// ============================================================================
// 12. COMPREHENSIVE INVENTORY REPORTING
// ============================================================================

async function getCurrentStockReport(companyId, filters = {}) {
  const conditions = ['i.company_id = $1'];
  const params = [companyId];
  let paramIdx = 2;

  if (filters.brandId) {
    conditions.push(`i.brand_id = $${paramIdx++}`);
    params.push(filters.brandId);
  }
  if (filters.categoryId) {
    conditions.push(`i.category_id = $${paramIdx++}`);
    params.push(filters.categoryId);
  }
  if (filters.locationId) {
    conditions.push(`sb.location_id = $${paramIdx++}`);
    params.push(filters.locationId);
  }

  const query = `
    SELECT i.id, i.sku, i.name, i.item_type,
           c.name AS category_name,
           b.name AS brand_name,
           u.code AS uom_code,
           COALESCE(sb.quantity_on_hand, 0.0000) AS quantity_on_hand,
           i.reorder_level, i.minimum_stock,
           COALESCE(sb.average_cost, i.current_cost) AS unit_cost,
           (COALESCE(sb.quantity_on_hand, 0.0000) * COALESCE(sb.average_cost, i.current_cost)) AS total_valuation,
           sl.name AS location_name
    FROM inventory_items i
    LEFT JOIN inventory_categories c ON i.category_id = c.id
    LEFT JOIN brands b ON i.brand_id = b.id
    JOIN units_of_measurement u ON i.uom_id = u.id
    LEFT JOIN stock_balances sb ON sb.inventory_item_id = i.id
    LEFT JOIN stock_locations sl ON sb.location_id = sl.id
    WHERE ${conditions.join(' AND ')} AND i.is_active = TRUE
    ORDER BY b.name NULLS LAST, i.name ASC
  `;

  const res = await pool.query(query, params);
  return res.rows;
}

async function getLowStockReport(companyId) {
  const query = `
    SELECT i.id, i.sku, i.name, i.item_type,
           b.name AS brand_name,
           u.code AS uom_code,
           COALESCE(sb.quantity_on_hand, 0.0000) AS quantity_on_hand,
           i.reorder_level, i.minimum_stock,
           COALESCE(sb.average_cost, i.current_cost) AS unit_cost
    FROM inventory_items i
    LEFT JOIN brands b ON i.brand_id = b.id
    JOIN units_of_measurement u ON i.uom_id = u.id
    LEFT JOIN (
      SELECT inventory_item_id, SUM(quantity_on_hand) AS quantity_on_hand, AVG(average_cost) AS average_cost
      FROM stock_balances
      WHERE company_id = $1
      GROUP BY inventory_item_id
    ) sb ON sb.inventory_item_id = i.id
    WHERE i.company_id = $1 AND i.is_active = TRUE
      AND COALESCE(sb.quantity_on_hand, 0.0000) <= i.reorder_level
      AND i.reorder_level > 0
    ORDER BY (COALESCE(sb.quantity_on_hand, 0.0000) - i.minimum_stock) ASC
  `;

  const res = await pool.query(query, [companyId]);
  return res.rows;
}

async function getOutOfStockReport(companyId) {
  const query = `
    SELECT i.id, i.sku, i.name, i.item_type,
           b.name AS brand_name,
           u.code AS uom_code,
           COALESCE(sb.quantity_on_hand, 0.0000) AS quantity_on_hand,
           i.minimum_stock
    FROM inventory_items i
    LEFT JOIN brands b ON i.brand_id = b.id
    JOIN units_of_measurement u ON i.uom_id = u.id
    LEFT JOIN (
      SELECT inventory_item_id, SUM(quantity_on_hand) AS quantity_on_hand
      FROM stock_balances
      WHERE company_id = $1
      GROUP BY inventory_item_id
    ) sb ON sb.inventory_item_id = i.id
    WHERE i.company_id = $1 AND i.is_active = TRUE
      AND COALESCE(sb.quantity_on_hand, 0.0000) <= 0
    ORDER BY i.name ASC
  `;

  const res = await pool.query(query, [companyId]);
  return res.rows;
}

async function getStockMovementReport(companyId, filters = {}) {
  const conditions = ['m.company_id = $1'];
  const params = [companyId];
  let paramIdx = 2;

  if (filters.inventoryItemId) {
    conditions.push(`m.inventory_item_id = $${paramIdx++}`);
    params.push(filters.inventoryItemId);
  }
  if (filters.movementType) {
    conditions.push(`m.movement_type = $${paramIdx++}`);
    params.push(filters.movementType);
  }
  if (filters.fromDate) {
    conditions.push(`m.created_at >= $${paramIdx++}`);
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    conditions.push(`m.created_at <= $${paramIdx++}`);
    params.push(filters.toDate);
  }

  const page = parseInt(filters.page || '1', 10);
  const limit = Math.min(parseInt(filters.limit || '50', 10), 100);
  const offset = (page - 1) * limit;

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM stock_movement_ledger m WHERE ${conditions.join(' AND ')}`,
    params
  );
  const total = countRes.rows[0].total;

  const dataQuery = `
    SELECT m.id, m.created_at, m.movement_type, m.quantity, m.balance_after,
           m.unit_cost, m.total_cost, m.source_type, m.source_reference,
           m.reason, m.notes,
           i.sku AS item_sku, i.name AS item_name,
           u.code AS uom_code,
           sl.name AS location_name,
           usr.full_name AS created_by_name
    FROM stock_movement_ledger m
    JOIN inventory_items i ON m.inventory_item_id = i.id
    JOIN units_of_measurement u ON i.uom_id = u.id
    JOIN stock_locations sl ON m.location_id = sl.id
    LEFT JOIN users usr ON m.created_by = usr.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.created_at DESC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `;
  params.push(limit, offset);

  const dataRes = await pool.query(dataQuery, params);

  return {
    movements: dataRes.rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  };
}

async function getWastageReport(companyId, filters = {}) {
  const conditions = ["m.company_id = $1 AND m.movement_type = 'WASTAGE'"];
  const params = [companyId];
  let paramIdx = 2;

  if (filters.fromDate) {
    conditions.push(`m.created_at >= $${paramIdx++}`);
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    conditions.push(`m.created_at <= $${paramIdx++}`);
    params.push(filters.toDate);
  }

  const query = `
    SELECT m.id, m.created_at, m.quantity, m.unit_cost, m.total_cost, m.reason,
           i.sku AS item_sku, i.name AS item_name,
           u.code AS uom_code,
           b.name AS brand_name,
           usr.full_name AS reported_by
    FROM stock_movement_ledger m
    JOIN inventory_items i ON m.inventory_item_id = i.id
    JOIN units_of_measurement u ON i.uom_id = u.id
    LEFT JOIN brands b ON i.brand_id = b.id
    LEFT JOIN users usr ON m.created_by = usr.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.created_at DESC
  `;

  const res = await pool.query(query, params);
  const totalWastageCost = res.rows.reduce((sum, r) => sum + Number(r.total_cost || 0), 0);

  return {
    items: res.rows,
    summary: {
      totalRecords: res.rows.length,
      totalWastageCost: totalWastageCost.toFixed(4)
    }
  };
}

async function getInventoryValuationReport(companyId) {
  const query = `
    SELECT i.id, i.sku, i.name, i.item_type,
           c.name AS category_name,
           b.name AS brand_name,
           u.code AS uom_code,
           COALESCE(SUM(sb.quantity_on_hand), 0.0000) AS quantity_on_hand,
           COALESCE(AVG(sb.average_cost), i.current_cost) AS average_unit_cost,
           COALESCE(SUM(sb.quantity_on_hand * sb.average_cost), 0.0000) AS total_valuation
    FROM inventory_items i
    LEFT JOIN inventory_categories c ON i.category_id = c.id
    LEFT JOIN brands b ON i.brand_id = b.id
    JOIN units_of_measurement u ON i.uom_id = u.id
    LEFT JOIN stock_balances sb ON sb.inventory_item_id = i.id
    WHERE i.company_id = $1 AND i.is_active = TRUE
    GROUP BY i.id, c.name, b.name, u.code
    ORDER BY total_valuation DESC
  `;

  const res = await pool.query(query, [companyId]);
  const totalValuation = res.rows.reduce((sum, r) => sum + Number(r.total_valuation || 0), 0);

  return {
    valuationMethod: 'MOVING_AVERAGE_COST',
    totalValuation: totalValuation.toFixed(4),
    itemCount: res.rows.length,
    items: res.rows
  };
}

async function getBrandWiseInventoryReport(companyId) {
  const query = `
    SELECT COALESCE(b.name, 'Shared Company Inventory') AS brand_name,
           COALESCE(b.code, 'SHARED') AS brand_code,
           COUNT(DISTINCT i.id) AS item_count,
           COALESCE(SUM(sb.quantity_on_hand), 0.0000) AS total_units_on_hand,
           COALESCE(SUM(sb.quantity_on_hand * sb.average_cost), 0.0000) AS total_valuation,
           COALESCE(SUM(CASE WHEN m.movement_type = 'SALE' THEN ABS(m.quantity) ELSE 0 END), 0.0000) AS total_units_sold_consumed,
           COALESCE(SUM(CASE WHEN m.movement_type = 'WASTAGE' THEN ABS(m.total_cost) ELSE 0 END), 0.0000) AS total_wastage_cost
    FROM inventory_items i
    LEFT JOIN brands b ON i.brand_id = b.id
    LEFT JOIN stock_balances sb ON sb.inventory_item_id = i.id
    LEFT JOIN stock_movement_ledger m ON m.inventory_item_id = i.id
    WHERE i.company_id = $1
    GROUP BY b.id, b.name, b.code
    ORDER BY total_valuation DESC
  `;

  const res = await pool.query(query, [companyId]);
  return res.rows;
}

async function getConsolidatedCompanyReport(companyId) {
  const valRes = await getInventoryValuationReport(companyId);
  const lowRes = await getLowStockReport(companyId);
  const outRes = await getOutOfStockReport(companyId);
  const brandRes = await getBrandWiseInventoryReport(companyId);

  return {
    companyId,
    timestamp: new Date().toISOString(),
    valuation: {
      method: valRes.valuationMethod,
      totalValuation: valRes.totalValuation,
      totalActiveItems: valRes.itemCount
    },
    alerts: {
      lowStockItemCount: lowRes.length,
      outOfStockItemCount: outRes.length
    },
    brandBreakdown: brandRes
  };
}

module.exports = {
  InventoryError,
  listUnitsOfMeasurement,
  createUnitOfMeasurement,
  listInventoryCategories,
  createInventoryCategory,
  listStockLocations,
  createStockLocation,
  getDefaultStockLocation,
  listInventoryItems,
  getInventoryItemById,
  createInventoryItem,
  updateInventoryItem,
  toggleInventoryItemActive,
  mapProductToInventoryItem,
  getProductInventoryMapping,
  createOrUpdateProductRecipe,
  getProductRecipe,
  recordStockMovementTx,
  setOpeningStock,
  receivePurchaseStock,
  createStockAdjustment,
  startStockCountSession,
  updateStockCountLine,
  reconcileStockCountSession,
  createStockTransfer,
  consumeStockForInvoiceTx,
  getCurrentStockReport,
  getLowStockReport,
  getOutOfStockReport,
  getStockMovementReport,
  getWastageReport,
  getInventoryValuationReport,
  getBrandWiseInventoryReport,
  getConsolidatedCompanyReport
};
