# AI Commenting Sidekick Backend

This is the backend API for the AI Commenting Sidekick Chrome extension.

## Setup Instructions

### 1. Supabase Setup

1. Go to [Supabase](https://app.supabase.com) and create a new project
2. Once created, go to Settings > API
3. Copy the following:
   - Project URL
   - Anon public key
   - Service role key (keep this secret!)

4. Go to SQL Editor and run the contents of `supabase-schema.sql` to create the database schema

### 2. Environment Variables

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```

2. Fill in the values:
   - `SUPABASE_URL`: Your Supabase project URL
   - `SUPABASE_ANON_KEY`: Your Supabase anon key
   - `SUPABASE_SERVICE_KEY`: Your Supabase service key
   - `OPENAI_API_KEY`: Your OpenAI API key
   - `JWT_SECRET`: Generate a random string (use `openssl rand -base64 32`)
   - `TEST_COUPON_CODE`: Test coupon code for subscription testing (optional)

### 3. Deploy to Vercel via GitHub

1. Create a new GitHub repository for your project

2. Initialize git and push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/ai-commenting-sidekick.git
   git push -u origin main
   ```

3. Connect to Vercel:
   - Go to [Vercel Dashboard](https://vercel.com/dashboard)
   - Click "New Project"
   - Import your GitHub repository
   - Select the `backend` directory as the root directory
   - Click "Deploy"

4. Set environment variables in Vercel:
   - Go to your project settings > Environment Variables
   - Add these variables:

   **Required (7):**
   - `OPENAI_API_KEY` - Your OpenAI API key
   - `SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_ANON_KEY` - Supabase anon/public key
   - `SUPABASE_SERVICE_KEY` - Supabase service role key (keep secret!)
   - `JWT_SECRET` - Generate with: `openssl rand -base64 32`
   - `NODE_ENV` - Set to `production`
   - `TEST_COUPON_CODE` - Your test coupon code (e.g., TEST2024)

   **CORS Configuration (1):**
   - `ALLOWED_ORIGINS` - For web domains only (Chrome extensions are automatically allowed)
     - Example: `https://ai-commenting-sidekick.automatemybiz.pro`
     - Note: You don't need to add Chrome extension IDs

   **Optional (2):**
   - `MAX_REQUESTS_PER_MINUTE` - Rate limit per user (default: 10)
   - `REQUEST_SIGNATURE_SECRET` - For request signing (optional)

   **Important**: Check all three boxes (Production, Preview, Development) for each variable

### 4. Update Chrome Extension

Update the extension to use your backend API URL instead of calling OpenAI directly.

## API Endpoints

### Authentication
- `POST /api/auth?action=signup` - Create new account
- `POST /api/auth?action=login` - Login
- `POST /api/auth?action=logout` - Logout
- `POST /api/auth?action=refresh` - Refresh token
- `GET /api/auth?action=user` - Get current user

### Credits
- `GET /api/credits` - Get user's credits and purchases
- `POST /api/credits` - Add credits (after payment)

### Analysis
- `POST /api/analyze` - Analyze image and generate response

### Health Check
- `GET /api/health` - API health check

## Testing

### Test Coupon System

For testing the subscription flow without payment gateway:

```bash
curl -X POST https://your-api.vercel.app/api/redeem-coupon \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"coupon_code": "YOUR_TEST_COUPON_CODE"}'
```

The test coupon:
- Configured via `TEST_COUPON_CODE` environment variable
- Grants 200 credits valid for 30 days
- Each user can only redeem once
- Used for testing the Pro subscription flow before payment gateway integration