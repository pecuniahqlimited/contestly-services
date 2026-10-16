-- Runs once when the local postgres volume is first created (docker-entrypoint-initdb.d).
-- DO Managed Postgres supports pgvector but needs this run once by hand (see ADR 0002).
CREATE EXTENSION IF NOT EXISTS vector;
