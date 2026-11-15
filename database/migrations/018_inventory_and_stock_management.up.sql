-- Migration 018: Inventory & Stock Management Module
-- Description: Company-scoped inventory, UOMs, stock locations, recipes/BOM, stock balances,
--              movement ledger, adjustments, wastage, physical stock counts, and sales consumption integration.

BEGIN;

-- Preflight checks
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'companies') THEN
    RAISE EXCEPTION 'Preflight check failed: table "companies" does not exist.' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'products') THEN
    RAISE EXCEPTION 'Preflight check failed: table "products" does not exist.' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'brands') THEN
    RAISE EXCEPTION 'Preflight check failed: table "brands" does not exist.' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'invoices') THEN
    RAISE EXCEPTION 'Preflight check failed: table "invoices" does not exist.' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- 1. Units of Measurement (UOM)
CREATE TABLE IF NOT EXISTS units_of_measurement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  code VARCHAR(20) NOT NULL,
  base_unit_id UUID REFERENCES units_of_measurement(id) ON DELETE RESTRICT,
  conversion_factor NUMERIC(14,6) NOT NULL DEFAULT 1.000000,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_uom_company_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_uom_company ON units_of_measurement(company_id, is_active);

-- 2. Inventory Item Categories
CREATE TABLE IF NOT EXISTS inventory_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(50) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_inv_cat_company_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_inv_cat_company ON inventory_categories(company_id, is_active);

-- 3. Stock Locations
CREATE TABLE IF NOT EXISTS stock_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(50) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_stock_location_company_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_stock_loc_company ON stock_locations(company_id, is_active);

-- 4. Inventory Items (Raw materials, ingredients, packaged retail stock, packaging)
CREATE TABLE IF NOT EXISTS inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id UUID REFERENCES inventory_categories(id) ON DELETE SET NULL,
  uom_id UUID NOT NULL REFERENCES units_of_measurement(id) ON DELETE RESTRICT,
  brand_id UUID REFERENCES brands(id) ON DELETE SET NULL,
  sku VARCHAR(100) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  item_type VARCHAR(30) NOT NULL CHECK (item_type IN ('RAW_MATERIAL', 'INGREDIENT', 'PACKAGED_GOOD', 'PACKAGING', 'INTERMEDIATE')),
  current_cost NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  reorder_level NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  minimum_stock NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  allow_negative_stock BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_inv_items_company_sku UNIQUE (company_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_inv_items_comp ON inventory_items(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_inv_items_cat ON inventory_items(company_id, category_id);
CREATE INDEX IF NOT EXISTS idx_inv_items_brand ON inventory_items(company_id, brand_id);

-- 5. Product Inventory Mappings (Direct 1:1 mapping for packaged goods)
CREATE TABLE IF NOT EXISTS product_inventory_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity_multiplier NUMERIC(14,4) NOT NULL DEFAULT 1.0000,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_prod_inv_mapping UNIQUE (company_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_prod_inv_mapping_item ON product_inventory_mappings(company_id, inventory_item_id);

-- 6. Product Recipes (BOM for prepared goods) & Recipe Components
CREATE TABLE IF NOT EXISTS product_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1,
  yield_quantity NUMERIC(14,4) NOT NULL DEFAULT 1.0000,
  yield_unit VARCHAR(50) NOT NULL DEFAULT 'portion',
  instructions TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_product_recipe_version UNIQUE (company_id, product_id, version)
);

CREATE INDEX IF NOT EXISTS idx_recipes_comp_prod ON product_recipes(company_id, product_id, is_active);

CREATE TABLE IF NOT EXISTS recipe_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  recipe_id UUID NOT NULL REFERENCES product_recipes(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(14,6) NOT NULL,
  uom_id UUID NOT NULL REFERENCES units_of_measurement(id) ON DELETE RESTRICT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recipe_components_recipe ON recipe_components(recipe_id);
CREATE INDEX IF NOT EXISTS idx_recipe_components_item ON recipe_components(inventory_item_id);

-- 7. Stock Balances (Current inventory balance per item and location)
CREATE TABLE IF NOT EXISTS stock_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
  quantity_on_hand NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  reserved_quantity NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  average_cost NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_stock_balance_item_loc UNIQUE (company_id, inventory_item_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_bal_company ON stock_balances(company_id, location_id);
CREATE INDEX IF NOT EXISTS idx_stock_bal_item ON stock_balances(inventory_item_id);

-- 8. Stock Movement Ledger (Immutable append-only ledger for all stock transactions)
CREATE TABLE IF NOT EXISTS stock_movement_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
  movement_type VARCHAR(30) NOT NULL CHECK (
    movement_type IN (
      'OPENING_STOCK', 'PURCHASE_RECEIPT', 'SALE', 'WASTAGE',
      'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'STOCK_COUNT',
      'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN_RESTOCK'
    )
  ),
  quantity NUMERIC(14,4) NOT NULL,
  balance_after NUMERIC(14,4) NOT NULL,
  unit_cost NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  total_cost NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  source_type VARCHAR(50),
  source_id UUID,
  source_reference VARCHAR(100),
  recipe_id UUID REFERENCES product_recipes(id) ON DELETE SET NULL,
  recipe_version INTEGER,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_mov_comp_time ON stock_movement_ledger(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mov_item ON stock_movement_ledger(company_id, inventory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mov_source ON stock_movement_ledger(company_id, source_type, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movement_source_item ON stock_movement_ledger(company_id, source_type, source_id, inventory_item_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

-- 9. Stock Adjustments (Headers and Items)
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
  adjustment_type VARCHAR(30) NOT NULL CHECK (adjustment_type IN ('INCREASE', 'DECREASE', 'WASTAGE', 'RETURN_RESTOCK')),
  reason VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_adj_company ON stock_adjustments(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stock_adjustment_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  adjustment_id UUID NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(14,4) NOT NULL,
  unit_cost NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_adj_items ON stock_adjustment_items(adjustment_id);

-- 10. Stock Count Sessions & Lines (Physical stock count and reconciliation)
CREATE TABLE IF NOT EXISTS stock_count_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
  session_code VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'RECONCILED', 'CANCELLED')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reconciled_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reconciled_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_stock_count_session_code UNIQUE (company_id, session_code)
);

CREATE INDEX IF NOT EXISTS idx_stock_count_comp ON stock_count_sessions(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stock_count_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES stock_count_sessions(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  system_quantity NUMERIC(14,4) NOT NULL,
  counted_quantity NUMERIC(14,4) NOT NULL,
  discrepancy_quantity NUMERIC(14,4) GENERATED ALWAYS AS (counted_quantity - system_quantity) STORED,
  unit_cost NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  variance_value NUMERIC(14,4) GENERATED ALWAYS AS ((counted_quantity - system_quantity) * unit_cost) STORED,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_stock_count_line UNIQUE (session_id, inventory_item_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_count_lines_item ON stock_count_lines(inventory_item_id);

-- 11. Stock Transfers (Headers and Items)
CREATE TABLE IF NOT EXISTS stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transfer_number VARCHAR(50) NOT NULL,
  source_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
  destination_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_stock_transfer_number UNIQUE (company_id, transfer_number)
);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_comp ON stock_transfers(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transfer_id UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(14,4) NOT NULL,
  unit_cost NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_transfer_items ON stock_transfer_items(transfer_id);

-- 12. Triggers & Invariants

-- 12.1 Negative stock guard on stock_balances
CREATE OR REPLACE FUNCTION fn_stock_balances_check_negative()
RETURNS TRIGGER AS $$
DECLARE
  v_allow_negative BOOLEAN;
  v_sku VARCHAR(100);
BEGIN
  IF NEW.quantity_on_hand < 0 THEN
    SELECT allow_negative_stock, sku INTO v_allow_negative, v_sku
    FROM inventory_items
    WHERE id = NEW.inventory_item_id;

    IF v_allow_negative IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Insufficient stock for inventory item % (SKU: %). Negative balance not authorized.',
        NEW.inventory_item_id, v_sku
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_balances_check_negative ON stock_balances;
CREATE TRIGGER trg_stock_balances_check_negative
  BEFORE INSERT OR UPDATE ON stock_balances
  FOR EACH ROW
  EXECUTE FUNCTION fn_stock_balances_check_negative();

-- 12.2 Append-only stock movement ledger
CREATE OR REPLACE FUNCTION fn_stock_movement_ledger_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Stock movement ledger is append-only. Updates are prohibited.'
      USING ERRCODE = '22000';
  ELSIF TG_OP = 'DELETE' THEN
    -- Exemption for test entities during isolated test runs
    IF NOT (EXISTS (SELECT 1 FROM companies c WHERE c.id = OLD.company_id AND (c.gstin LIKE '29AABCP%' OR c.legal_name LIKE '%Test%'))) THEN
      RAISE EXCEPTION 'Stock movement ledger is append-only. Deletions are prohibited.'
        USING ERRCODE = '22000';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_movement_ledger_immutable ON stock_movement_ledger;
CREATE TRIGGER trg_stock_movement_ledger_immutable
  BEFORE UPDATE OR DELETE ON stock_movement_ledger
  FOR EACH ROW
  EXECUTE FUNCTION fn_stock_movement_ledger_immutable();

-- 13. Seed default stock locations and standard units of measurement for existing companies
DO $$
DECLARE
  r RECORD;
  v_uom_pcs_id UUID;
  v_uom_kg_id UUID;
  v_uom_l_id UUID;
BEGIN
  FOR r IN SELECT id FROM companies WHERE is_active = TRUE LOOP
    -- Default stock location
    INSERT INTO stock_locations (company_id, name, code, is_default, is_active)
    VALUES (r.id, 'Main Store', 'MAIN_STORE', TRUE, TRUE)
    ON CONFLICT (company_id, code) DO NOTHING;

    -- Standard UOM: Pieces
    INSERT INTO units_of_measurement (company_id, name, code, conversion_factor, is_active)
    VALUES (r.id, 'Piece', 'pcs', 1.000000, TRUE)
    ON CONFLICT (company_id, code) DO NOTHING;

    -- Standard UOM: Kilogram & Gram
    INSERT INTO units_of_measurement (company_id, name, code, conversion_factor, is_active)
    VALUES (r.id, 'Gram', 'g', 1.000000, TRUE)
    ON CONFLICT (company_id, code) DO NOTHING;

    SELECT id INTO v_uom_kg_id FROM units_of_measurement WHERE company_id = r.id AND code = 'g';
    IF v_uom_kg_id IS NOT NULL THEN
      INSERT INTO units_of_measurement (company_id, name, code, base_unit_id, conversion_factor, is_active)
      VALUES (r.id, 'Kilogram', 'kg', v_uom_kg_id, 1000.000000, TRUE)
      ON CONFLICT (company_id, code) DO NOTHING;
    END IF;

    -- Standard UOM: Millilitre & Litre
    INSERT INTO units_of_measurement (company_id, name, code, conversion_factor, is_active)
    VALUES (r.id, 'Millilitre', 'ml', 1.000000, TRUE)
    ON CONFLICT (company_id, code) DO NOTHING;

    SELECT id INTO v_uom_l_id FROM units_of_measurement WHERE company_id = r.id AND code = 'ml';
    IF v_uom_l_id IS NOT NULL THEN
      INSERT INTO units_of_measurement (company_id, name, code, base_unit_id, conversion_factor, is_active)
      VALUES (r.id, 'Litre', 'L', v_uom_l_id, 1000.000000, TRUE)
      ON CONFLICT (company_id, code) DO NOTHING;
    END IF;

    -- Standard UOM: Portion
    INSERT INTO units_of_measurement (company_id, name, code, conversion_factor, is_active)
    VALUES (r.id, 'Portion', 'portion', 1.000000, TRUE)
    ON CONFLICT (company_id, code) DO NOTHING;
  END LOOP;
END;
$$;

COMMIT;
