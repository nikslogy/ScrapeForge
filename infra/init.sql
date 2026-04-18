-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    password_hash VARCHAR(255),
    plan VARCHAR(50) DEFAULT 'free',
    stripe_customer_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- API keys table
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(255) UNIQUE NOT NULL,
    key_prefix VARCHAR(12) NOT NULL,
    name VARCHAR(255) DEFAULT 'Default',
    is_active BOOLEAN DEFAULT true,
    rate_limit_per_minute INTEGER DEFAULT 60,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- Request logs table
CREATE TABLE request_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    api_key_id UUID REFERENCES api_keys(id),
    job_id VARCHAR(255),
    url TEXT NOT NULL,
    domain VARCHAR(255) NOT NULL,
    method VARCHAR(10) DEFAULT 'scrape',
    tier_used SMALLINT,
    proxy_tier VARCHAR(20),
    status VARCHAR(20) NOT NULL,
    status_code INTEGER,
    latency_ms INTEGER,
    cost_breakdown JSONB DEFAULT '{}',
    total_cost DECIMAL(10, 6),
    quality_score DECIMAL(3, 2),
    cached BOOLEAN DEFAULT false,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX idx_logs_user ON request_logs(user_id);
CREATE INDEX idx_logs_domain ON request_logs(domain);
CREATE INDEX idx_logs_created ON request_logs(created_at);
CREATE INDEX idx_logs_status ON request_logs(status);

-- Usage aggregation table (updated hourly by background job)
CREATE TABLE usage_daily (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    date DATE NOT NULL,
    total_requests INTEGER DEFAULT 0,
    successful_requests INTEGER DEFAULT 0,
    failed_requests INTEGER DEFAULT 0,
    cached_requests INTEGER DEFAULT 0,
    tier1_requests INTEGER DEFAULT 0,
    tier2_requests INTEGER DEFAULT 0,
    tier3_requests INTEGER DEFAULT 0,
    tier4_requests INTEGER DEFAULT 0,
    total_cost DECIMAL(10, 4) DEFAULT 0,
    avg_latency_ms INTEGER DEFAULT 0,
    avg_quality_score DECIMAL(3, 2),
    UNIQUE(user_id, date)
);
CREATE INDEX idx_usage_user_date ON usage_daily(user_id, date);

-- Domain strategy cache (mirrors Redis, for analytics)
CREATE TABLE domain_strategies (
    domain VARCHAR(255) PRIMARY KEY,
    tier SMALLINT NOT NULL,
    proxy_tier VARCHAR(20),
    success_rate DECIMAL(5, 2),
    avg_latency_ms INTEGER,
    sample_size INTEGER DEFAULT 0,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
