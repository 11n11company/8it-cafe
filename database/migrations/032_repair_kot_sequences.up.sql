-- Migration 032: Self-healing KOT Sequences & Collision Prevention
-- Repairs kot_sequences based on actual MAX numeric suffix in kots table,
-- and enhances fn_get_next_kot_sequence to automatically detect and skip existing KOT numbers.

BEGIN;

-- 1. Synchronize kot_sequences for PARCEL
UPDATE kot_sequences ks
SET last_value = GREATEST(ks.last_value, COALESCE((
    SELECT MAX((SUBSTRING(k.kot_number FROM '^KOT-PCL-([0-9]+)'))::BIGINT)
    FROM kots k
    WHERE k.company_id = ks.company_id
      AND k.is_reprint = FALSE
      AND k.kot_number ~ '^KOT-PCL-[0-9]+'
), 0))
WHERE ks.sequence_type = 'PARCEL';

-- 2. Synchronize kot_sequences for DINE_IN
UPDATE kot_sequences ks
SET last_value = GREATEST(ks.last_value, COALESCE((
    SELECT MAX((SUBSTRING(k.kot_number FROM '^KOT-T[0-9]+-B[0-9]+-([0-9]+)'))::BIGINT)
    FROM kots k
    WHERE k.company_id = ks.company_id
      AND k.is_reprint = FALSE
      AND k.kot_number ~ '^KOT-T[0-9]+-B[0-9]+-[0-9]+'
), 0))
WHERE ks.sequence_type = 'DINE_IN';

-- 3. Synchronize kot_sequences for STANDARD
UPDATE kot_sequences ks
SET last_value = GREATEST(ks.last_value, COALESCE((
    SELECT MAX((SUBSTRING(k.kot_number FROM '^KOT-[0-9]{4}-([0-9]+)'))::BIGINT)
    FROM kots k
    WHERE k.company_id = ks.company_id
      AND k.is_reprint = FALSE
      AND k.kot_number ~ '^KOT-[0-9]{4}-[0-9]+'
), 0))
WHERE ks.sequence_type = 'STANDARD';

-- 4. Replace fn_get_next_kot_sequence with collision-safe loop
CREATE OR REPLACE FUNCTION fn_get_next_kot_sequence(p_company_id UUID, p_sequence_type VARCHAR)
RETURNS BIGINT AS $$
DECLARE
    v_next BIGINT;
    v_exists BOOLEAN;
BEGIN
    LOOP
        INSERT INTO kot_sequences (company_id, sequence_type, last_value)
        VALUES (p_company_id, p_sequence_type, 1)
        ON CONFLICT (company_id, sequence_type)
        DO UPDATE SET last_value = kot_sequences.last_value + 1, updated_at = clock_timestamp()
        RETURNING last_value INTO v_next;

        -- Verify if a non-reprint KOT with this sequence already exists for the company
        IF p_sequence_type = 'PARCEL' THEN
            SELECT EXISTS (
                SELECT 1 FROM kots 
                WHERE company_id = p_company_id 
                  AND (
                    kot_number = 'KOT-PCL-' || LPAD(v_next::TEXT, 5, '0')
                    OR kot_number LIKE 'KOT-PCL-' || LPAD(v_next::TEXT, 5, '0') || '-%'
                  )
            ) INTO v_exists;
        ELSIF p_sequence_type = 'DINE_IN' THEN
            SELECT EXISTS (
                SELECT 1 FROM kots 
                WHERE company_id = p_company_id 
                  AND (
                    kot_number LIKE '%-' || LPAD(v_next::TEXT, 4, '0')
                    OR kot_number LIKE '%-' || LPAD(v_next::TEXT, 4, '0') || '-%'
                  )
            ) INTO v_exists;
        ELSIF p_sequence_type = 'STANDARD' THEN
            SELECT EXISTS (
                SELECT 1 FROM kots 
                WHERE company_id = p_company_id 
                  AND (
                    kot_number LIKE 'KOT-%-' || LPAD(v_next::TEXT, 5, '0')
                    OR kot_number LIKE 'KOT-%-' || LPAD(v_next::TEXT, 5, '0') || '-%'
                    OR kot_number = 'KOT-' || LPAD(v_next::TEXT, 5, '0')
                  )
            ) INTO v_exists;
        ELSE
            v_exists := FALSE;
        END IF;

        IF NOT v_exists THEN
            EXIT;
        END IF;
    END LOOP;

    RETURN v_next;
END;
$$ LANGUAGE plpgsql;

COMMIT;
