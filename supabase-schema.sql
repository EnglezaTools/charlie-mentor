-- Students table
CREATE TABLE IF NOT EXISTS students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    heartbeat_id TEXT,
    name TEXT,
    first_name TEXT,
    bio TEXT,
    onboarding_responses JSONB DEFAULT '{}',
    groups TEXT[] DEFAULT '{}',
    token UUID UNIQUE DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id BIGSERIAL PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES students(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Community cache table
CREATE TABLE IF NOT EXISTS community_cache (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_conversations_student ON conversations(student_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);
CREATE INDEX IF NOT EXISTS idx_students_token ON students(token);

-- Enable Row Level Security (disabled for server-side access)
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_cache ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, so no policies needed for server-side
