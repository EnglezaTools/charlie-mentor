# Charlie — Learning Mentor for Engleza Britanică Academy

Charlie is a warm, encouraging AI learning mentor for students of **Engleza Britanică Academy** — an English-learning community for Romanian speakers. Charlie motivates students, tracks their progress, and guides them to the right courses and resources.

## Architecture

- **Frontend**: Static HTML/CSS/JS served from `/public/`
- **Backend**: Vercel Serverless Functions (Node.js) in `/api/`
- **Database**: Supabase (PostgreSQL)
- **AI**: OpenAI GPT-4o-mini
- **Community**: Heartbeat.chat API integration

## Deployment Guide

### 1. Supabase Setup

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the schema from `supabase-schema.sql`
3. Go to **Settings > API** and copy:
   - **Project URL** (e.g., `https://xxx.supabase.co`)
   - **service_role key** (NOT the anon key — the secret one)

### 2. Vercel Setup

1. Push this code to a GitHub repository
2. Go to [vercel.com](https://vercel.com) and import the repository
3. Add environment variables in Vercel project settings:

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service_role key (secret) |
| `HEARTBEAT_API_KEY` | Heartbeat API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `ADMIN_SECRET` | Secret for admin endpoints (choose a strong password) |

4. Deploy!

### 3. Seed Community Data

After the first deployment, load community data from Heartbeat by visiting:

```
https://your-app.vercel.app/api/sync?secret=YOUR_ADMIN_SECRET
```

This fetches channels, courses, and members from Heartbeat and caches them in Supabase.

### 4. Embed in Heartbeat

Add Charlie to your Heartbeat community using an iframe:

```html
<iframe 
  src="https://your-app.vercel.app" 
  width="100%" 
  height="600px" 
  frameborder="0" 
  style="border-radius: 12px;"
></iframe>
```

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/auth` | POST | Student login by email |
| `/api/chat` | POST | Send message to Charlie |
| `/api/history` | GET | Load past messages |
| `/api/sync` | GET | Refresh Heartbeat data (admin) |
| `/api/health` | GET | Health check |

## Environment Variables

Copy `.env.example` to `.env` for local development:

```bash
cp .env.example .env
```

## How Charlie Works

1. **Student logs in** with their email → verified against Heartbeat community members
2. **Charlie greets** the student warmly in Romanian
3. **Student chats** with Charlie about their learning journey
4. **Charlie motivates**, guides to courses/channels, and tracks progress
5. **Charlie does NOT teach English** — redirects grammar/vocab questions to the appropriate channels

## Tech Stack

- Node.js 18+ (Vercel serverless)
- Supabase PostgreSQL
- OpenAI GPT-4o-mini
- Heartbeat.chat API
- Vanilla HTML/CSS/JS frontend
