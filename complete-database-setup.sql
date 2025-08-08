-- Complete Database Setup for AI Commenting Sidekick
-- Run this after clearing all data from Supabase

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Create users table
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  tier TEXT DEFAULT 'free' CHECK (tier IN ('free', 'pro')),
  stripe_customer_id TEXT UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create subscriptions table (without remaining_credits)
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'canceled', 'past_due', 'incomplete')),
  current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
  current_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
  credits_per_period INTEGER NOT NULL DEFAULT 200,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create credit_purchases table (single source of truth for credits)
CREATE TABLE IF NOT EXISTS public.credit_purchases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  credits INTEGER NOT NULL,
  remaining_credits INTEGER NOT NULL,
  amount_paid DECIMAL(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  stripe_payment_intent_id TEXT,
  stripe_checkout_session_id TEXT,
  purchase_type TEXT NOT NULL CHECK (purchase_type IN ('subscription', 'topup', 'one_time')),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create api_usage table
CREATE TABLE IF NOT EXISTS public.api_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  purchase_id UUID REFERENCES public.credit_purchases(id) ON DELETE SET NULL,
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  context TEXT,
  ai_response TEXT,
  credits_used INTEGER NOT NULL DEFAULT 1,
  api_key_used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Create subscription_history table
CREATE TABLE IF NOT EXISTS public.subscription_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  stripe_event_id TEXT UNIQUE,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Create indexes for performance
CREATE INDEX idx_users_email ON public.users(email);
CREATE INDEX idx_users_stripe_customer_id ON public.users(stripe_customer_id);
CREATE INDEX idx_subscriptions_user_id ON public.subscriptions(user_id);
CREATE INDEX idx_subscriptions_status ON public.subscriptions(status);
CREATE INDEX idx_credit_purchases_user_id ON public.credit_purchases(user_id);
CREATE INDEX idx_credit_purchases_expires_at ON public.credit_purchases(expires_at);
CREATE INDEX idx_api_usage_user_id ON public.api_usage(user_id);
CREATE INDEX idx_api_usage_created_at ON public.api_usage(created_at DESC);

-- 7. Create function to get available credits (from credit_purchases only)
CREATE OR REPLACE FUNCTION get_available_credits(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
  total_credits INTEGER := 0;
BEGIN
  -- Get credits from credit_purchases table only
  SELECT COALESCE(SUM(remaining_credits), 0)
  INTO total_credits
  FROM public.credit_purchases
  WHERE user_id = p_user_id
    AND expires_at > NOW()
    AND payment_status = 'completed'
    AND remaining_credits > 0;
  
  RETURN total_credits;
END;
$$ LANGUAGE plpgsql;

-- 8. Create function to use credits (FIFO)
CREATE OR REPLACE FUNCTION use_credits(
  p_user_id UUID, 
  p_credits_to_use INTEGER DEFAULT 1,
  p_api_key_used BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(
  success BOOLEAN, 
  message TEXT, 
  purchase_id UUID,
  subscription_id UUID
) AS $$
DECLARE
  v_record RECORD;
  v_credits_remaining INTEGER := p_credits_to_use;
  v_used_purchase_id UUID;
  v_used_subscription_id UUID;
  v_total_available INTEGER;
BEGIN
  -- If using own API key, just log usage
  IF p_api_key_used THEN
    RETURN QUERY SELECT TRUE, 'Using own API key', NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- Check total available credits
  SELECT COALESCE(SUM(remaining_credits), 0)
  INTO v_total_available
  FROM public.credit_purchases
  WHERE user_id = p_user_id
    AND expires_at > NOW()
    AND payment_status = 'completed'
    AND remaining_credits > 0;

  -- Check if user has enough credits
  IF v_total_available < p_credits_to_use THEN
    RETURN QUERY SELECT FALSE, 'Insufficient credits', NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- Use credits from credit_purchases (FIFO - oldest first)
  FOR v_record IN
    SELECT 
      id AS purchase_id,
      subscription_id,
      remaining_credits,
      expires_at
    FROM public.credit_purchases
    WHERE user_id = p_user_id
      AND expires_at > NOW()
      AND payment_status = 'completed'
      AND remaining_credits > 0
    ORDER BY created_at ASC
  LOOP
    IF v_credits_remaining <= 0 THEN
      EXIT;
    END IF;

    IF v_record.remaining_credits >= v_credits_remaining THEN
      -- This purchase has enough credits
      UPDATE public.credit_purchases
      SET remaining_credits = remaining_credits - v_credits_remaining
      WHERE id = v_record.purchase_id;
      
      v_used_purchase_id := v_record.purchase_id;
      v_used_subscription_id := v_record.subscription_id;
      v_credits_remaining := 0;
    ELSE
      -- Use all credits from this purchase
      UPDATE public.credit_purchases
      SET remaining_credits = 0
      WHERE id = v_record.purchase_id;
      
      v_credits_remaining := v_credits_remaining - v_record.remaining_credits;
      
      -- Set IDs if this is the first purchase we're using
      IF v_used_purchase_id IS NULL THEN
        v_used_purchase_id := v_record.purchase_id;
        v_used_subscription_id := v_record.subscription_id;
      END IF;
    END IF;
  END LOOP;

  RETURN QUERY SELECT TRUE, 'Credits deducted successfully', v_used_purchase_id, v_used_subscription_id;
END;
$$ LANGUAGE plpgsql;

-- 9. Enable Row Level Security
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_history ENABLE ROW LEVEL SECURITY;

-- 10. Create RLS policies
-- Users can only see their own data
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can view own subscriptions" ON public.subscriptions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view own credit purchases" ON public.credit_purchases
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view own API usage" ON public.api_usage
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view own subscription history" ON public.subscription_history
  FOR SELECT USING (auth.uid() = user_id);

-- Service role can do everything (your backend uses service role)
CREATE POLICY "Service role full access users" ON public.users
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access subscriptions" ON public.subscriptions
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access credit_purchases" ON public.credit_purchases
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access api_usage" ON public.api_usage
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access subscription_history" ON public.subscription_history
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- 11. Add table comments for documentation
COMMENT ON TABLE public.subscriptions IS 'Tracks subscription plans and periods. Actual credit balances are tracked in credit_purchases table.';
COMMENT ON TABLE public.credit_purchases IS 'Tracks all credit purchases and balances. This is the single source of truth for remaining credits.';
COMMENT ON COLUMN public.subscriptions.credits_per_period IS 'The number of credits included in this subscription plan';
COMMENT ON COLUMN public.credit_purchases.remaining_credits IS 'Current remaining credits from this purchase. This is the authoritative source for credit balance.';

-- 12. Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 13. Add updated_at triggers
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_credit_purchases_updated_at BEFORE UPDATE ON public.credit_purchases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();