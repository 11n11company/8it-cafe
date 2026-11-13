-- Migration: 011_create_revoked_tokens (Down)
-- Description: Drops revoked_tokens table and associated indexes

DROP TABLE IF EXISTS revoked_tokens CASCADE;

