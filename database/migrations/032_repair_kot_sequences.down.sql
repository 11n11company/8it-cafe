BEGIN;

-- Restore simple fn_get_next_kot_sequence from migration 024
CREATE OR REPLACE FUNCTION fn_get_next_kot_sequence(p_company_id UUID, p_sequence_type VARCHAR)
RETURNS BIGINT AS $$
DECLARE
    v_next BIGINT;
BEGIN
    INSERT INTO kot_sequences (company_id, sequence_type, last_value)
    VALUES (p_company_id, p_sequence_type, 1)
    ON CONFLICT (company_id, sequence_type)
    DO UPDATE SET last_value = kot_sequences.last_value + 1, updated_at = clock_timestamp()
    RETURNING last_value INTO v_next;
    
    RETURN v_next;
END;
$$ LANGUAGE plpgsql;

COMMIT;

