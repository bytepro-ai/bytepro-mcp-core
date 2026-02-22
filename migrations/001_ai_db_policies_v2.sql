-- =============================================================================
-- Migration: 001_ai_db_policies_v2
-- Purpose:   Upgrade ai_db_policies to the v2 deterministic resolution schema.
--
-- Changes vs v1:
--   + effect      VARCHAR(5)  NOT NULL  -- replaces `allowed` BOOLEAN
--   + priority    INT         NOT NULL  -- explicit precedence tier; higher = wins
--   + version     INT         NOT NULL  -- monotonic counter per (tenant,role,table,priority)
--   + is_active   BOOLEAN     NOT NULL  -- soft-deactivation; never DELETE for audit trail
--   + created_at  TIMESTAMP   NOT NULL
--   + updated_at  TIMESTAMP   NOT NULL
--
-- Resolution guarantee: result is independent of DB row order.
-- See: docs/architecture/policy-resolution-v2.md
--
-- Backward mapping for existing rows:
--   allowed = TRUE  →  effect = 'allow'
--   allowed = FALSE →  effect = 'deny'
--
-- Run order: this file must be applied once against the target schema/database.
-- Prerequisite: the database containing ai_db_policies is accessible.
-- =============================================================================


-- =============================================================================
-- SECTION A: MySQL / MariaDB
-- =============================================================================

-- A1. Create the v2 table (fresh install)
-- Apply to environments that do NOT yet have ai_db_policies.

/*
CREATE TABLE ai_db_policies (
  id          BIGINT        NOT NULL AUTO_INCREMENT,
  tenant_id   VARCHAR(255)  NOT NULL,
  role        VARCHAR(255)  NOT NULL,
  table_name  VARCHAR(255)  NOT NULL,
  effect      VARCHAR(5)    NOT NULL COMMENT 'allow | deny',
  priority    INT           NOT NULL DEFAULT 0,
  version     INT           NOT NULL DEFAULT 1,
  is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
  start_time  TIME          NULL     COMMENT 'UTC HH:MM:SS; NULL means no lower bound',
  end_time    TIME          NULL     COMMENT 'UTC HH:MM:SS; NULL means no upper bound',
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT pk_ai_db_policies PRIMARY KEY (id),
  CONSTRAINT chk_effect       CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT uq_policy_tuple  UNIQUE  (tenant_id, role, table_name, priority, version),
  INDEX idx_tenant_role_table (tenant_id, role, table_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
*/

-- A2. Alter existing v1 table (upgrade in-place)
-- Apply to environments that already have ai_db_policies with the v1 schema.

/*
ALTER TABLE ai_db_policies
  ADD COLUMN effect     VARCHAR(5)  NOT NULL DEFAULT 'allow' COMMENT 'allow | deny',
  ADD COLUMN priority   INT         NOT NULL DEFAULT 0,
  ADD COLUMN version    INT         NOT NULL DEFAULT 1,
  ADD COLUMN is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Populate effect from existing allowed column
UPDATE ai_db_policies SET effect = CASE WHEN allowed = 1 THEN 'allow' ELSE 'deny' END;

-- Add constraints after data migration
ALTER TABLE ai_db_policies
  ADD CONSTRAINT chk_effect      CHECK (effect IN ('allow', 'deny')),
  ADD CONSTRAINT uq_policy_tuple UNIQUE (tenant_id, role, table_name, priority, version),
  ADD INDEX idx_tenant_role_table (tenant_id, role, table_name);
*/


-- =============================================================================
-- SECTION B: PostgreSQL
-- =============================================================================

-- B1. Create the v2 table (fresh install)

/*
CREATE TABLE ai_db_policies (
  id          BIGSERIAL     NOT NULL,
  tenant_id   VARCHAR(255)  NOT NULL,
  role        VARCHAR(255)  NOT NULL,
  table_name  VARCHAR(255)  NOT NULL,
  effect      VARCHAR(5)    NOT NULL CHECK (effect IN ('allow', 'deny')),
  priority    INT           NOT NULL DEFAULT 0,
  version     INT           NOT NULL DEFAULT 1,
  is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
  start_time  TIME          NULL,
  end_time    TIME          NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_ai_db_policies  PRIMARY KEY (id),
  CONSTRAINT uq_policy_tuple    UNIQUE (tenant_id, role, table_name, priority, version)
);
CREATE INDEX idx_tenant_role_table ON ai_db_policies (tenant_id, role, table_name);

-- Trigger to keep updated_at current
CREATE OR REPLACE FUNCTION ai_db_policies_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_db_policies_updated_at
  BEFORE UPDATE ON ai_db_policies
  FOR EACH ROW EXECUTE FUNCTION ai_db_policies_set_updated_at();
*/

-- B2. Alter existing v1 table (upgrade in-place)

/*
ALTER TABLE ai_db_policies
  ADD COLUMN effect     VARCHAR(5)   NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow', 'deny')),
  ADD COLUMN priority   INT          NOT NULL DEFAULT 0,
  ADD COLUMN version    INT          NOT NULL DEFAULT 1,
  ADD COLUMN is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ADD COLUMN updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW();

-- Populate effect from existing allowed column
UPDATE ai_db_policies SET effect = CASE WHEN allowed THEN 'allow' ELSE 'deny' END;

-- Add uniqueness constraint after data migration
ALTER TABLE ai_db_policies
  ADD CONSTRAINT uq_policy_tuple UNIQUE (tenant_id, role, table_name, priority, version);
CREATE INDEX idx_tenant_role_table ON ai_db_policies (tenant_id, role, table_name);
*/


-- =============================================================================
-- SECTION C: Microsoft SQL Server (MSSQL)
-- =============================================================================

-- C1. Create the v2 table (fresh install)

/*
CREATE TABLE ai_db_policies (
  id          BIGINT        NOT NULL IDENTITY(1,1),
  tenant_id   VARCHAR(255)  NOT NULL,
  role        VARCHAR(255)  NOT NULL,
  table_name  VARCHAR(255)  NOT NULL,
  effect      VARCHAR(5)    NOT NULL,
  priority    INT           NOT NULL CONSTRAINT df_priority   DEFAULT 0,
  version     INT           NOT NULL CONSTRAINT df_version    DEFAULT 1,
  is_active   BIT           NOT NULL CONSTRAINT df_is_active  DEFAULT 1,
  start_time  TIME          NULL,
  end_time    TIME          NULL,
  created_at  DATETIME2     NOT NULL CONSTRAINT df_created_at DEFAULT GETUTCDATE(),
  updated_at  DATETIME2     NOT NULL CONSTRAINT df_updated_at DEFAULT GETUTCDATE(),

  CONSTRAINT pk_ai_db_policies PRIMARY KEY CLUSTERED (id),
  CONSTRAINT chk_effect        CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT uq_policy_tuple   UNIQUE (tenant_id, role, table_name, priority, version)
);
CREATE INDEX idx_tenant_role_table ON ai_db_policies (tenant_id, role, table_name);
*/

-- C2. Alter existing v1 table (upgrade in-place)

/*
ALTER TABLE ai_db_policies
  ADD effect     VARCHAR(5)  NOT NULL CONSTRAINT df_effect     DEFAULT 'allow',
      priority   INT         NOT NULL CONSTRAINT df_priority   DEFAULT 0,
      version    INT         NOT NULL CONSTRAINT df_version    DEFAULT 1,
      is_active  BIT         NOT NULL CONSTRAINT df_is_active  DEFAULT 1,
      created_at DATETIME2   NOT NULL CONSTRAINT df_created_at DEFAULT GETUTCDATE(),
      updated_at DATETIME2   NOT NULL CONSTRAINT df_updated_at DEFAULT GETUTCDATE();
GO

-- Populate effect from existing allowed column
UPDATE ai_db_policies SET effect = CASE WHEN allowed = 1 THEN 'allow' ELSE 'deny' END;
GO

-- Add constraints
ALTER TABLE ai_db_policies
  ADD CONSTRAINT chk_effect      CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT uq_policy_tuple     UNIQUE (tenant_id, role, table_name, priority, version);
CREATE INDEX idx_tenant_role_table ON ai_db_policies (tenant_id, role, table_name);
GO
*/


-- =============================================================================
-- SECTION D: Resolution guarantees (informational, not executable)
-- =============================================================================
--
-- Total ordering function: f(p) = (p.priority, [p.effect='deny'], p.version)
-- Lexicographic comparison over (Z x {0,1} x Z).
--
-- For any request R=(tenant, role, table, now_utc), the engine:
--  1. Loads all is_active=TRUE rows for the (tenant, role, table) key
--  2. Per priority group: retains max(version) row only
--  3. Filters to rows whose time window includes now_utc
--  4. If no rows remain: DENY (NO_POLICY or NO_ACTIVE_POLICY)
--  5. Selects rows at max(priority)
--  6. If any such row has effect='deny': DENY (TABLE_DENIED)
--  7. Otherwise: ALLOW
--
-- This is independent of the order rows appear in the database.
-- =============================================================================
