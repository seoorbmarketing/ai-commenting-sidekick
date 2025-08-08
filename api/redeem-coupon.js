const { supabaseAdmin } = require('../lib/supabase');

// Test coupon configuration from environment variables
const TEST_COUPON = process.env.TEST_COUPON_CODE;
// Test coupon gives same benefits as Pro tier
const PRO_CREDITS = parseInt(process.env.PRO_CREDITS_PER_MONTH || '200');
const PRO_VALIDITY_DAYS = parseInt(process.env.PRO_VALIDITY_DAYS || '30');

// Fixed UUID for test coupon (to avoid UUID format errors)
const TEST_COUPON_UUID = '00000000-0000-0000-0000-000000000001';

// Log configuration on startup
console.log('[Coupon] Service initialized:', {
  hasCouponCode: !!TEST_COUPON,
  hasSupabaseUrl: !!process.env.SUPABASE_URL,
  hasSupabaseKey: !!process.env.SUPABASE_SERVICE_KEY
});

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { coupon_code } = req.body;

  if (!coupon_code) {
    return res.status(400).json({ error: 'Coupon code required' });
  }

  try {
    // Log incoming request for debugging
    console.log('[Coupon] Redemption attempt:', {
      coupon_code: coupon_code,
      hasAuth: !!authHeader,
      testCouponConfigured: !!TEST_COUPON,
      testCouponLength: TEST_COUPON ? TEST_COUPON.length : 0
    });

    // Check if Supabase is properly configured
    if (!supabaseAdmin) {
      console.error('[Coupon] Supabase Admin client not initialized');
      return res.status(500).json({ error: 'Database configuration error' });
    }

    // Verify user
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      console.error('[Coupon] Auth error:', authError);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('[Coupon] User verified:', user.email);

    // Ensure user profile exists in our database
    const { data: existingUser, error: userCheckError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', user.id)
      .single();

    if (!existingUser) {
      console.log('[Coupon] Creating user profile for:', user.email);
      const { error: createError } = await supabaseAdmin
        .from('users')
        .insert([{
          id: user.id,
          email: user.email,
          tier: 'free'
        }]);
      
      if (createError) {
        console.error('[Coupon] Failed to create user profile:', createError);
        return res.status(500).json({ error: 'Failed to create user profile' });
      }
    }

    // Check if test coupon is configured
    if (!TEST_COUPON) {
      console.error('[Coupon] TEST_COUPON_CODE not configured in environment');
      return res.status(404).json({ error: 'Coupon system not configured' });
    }

    // Validate coupon code
    if (coupon_code.toUpperCase() !== TEST_COUPON.toUpperCase()) {
      console.log('[Coupon] Code mismatch:', {
        provided: coupon_code.toUpperCase(),
        expected: TEST_COUPON.toUpperCase()
      });
      return res.status(404).json({ error: 'Invalid coupon code' });
    }

    console.log('[Coupon] Processing coupon redemption...');

    // Check if user already has an active subscription
    const { data: existingSubscription } = await supabaseAdmin
      .from('subscriptions')
      .select('id')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .gt('current_period_end', new Date().toISOString())
      .single();

    if (existingSubscription) {
      console.log('[Coupon] User already has active subscription');
      return res.status(400).json({ 
        error: 'You already have an active Pro subscription' 
      });
    }

    // Create dates for subscription period
    const currentPeriodStart = new Date();
    const currentPeriodEnd = new Date();
    currentPeriodEnd.setDate(currentPeriodEnd.getDate() + PRO_VALIDITY_DAYS);

    // Create subscription record (same as Stripe webhook does)
    console.log('[Coupon] Creating subscription record...');
    
    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .insert([{
        user_id: user.id,
        stripe_subscription_id: 'COUPON_SUB_' + Date.now(), // Unique ID for coupon subscriptions
        stripe_customer_id: 'COUPON_CUSTOMER', // Placeholder for coupon users
        stripe_price_id: 'COUPON_PRICE', // Placeholder price ID
        status: 'active',
        current_period_start: currentPeriodStart.toISOString(),
        current_period_end: currentPeriodEnd.toISOString(),
        credits_per_period: PRO_CREDITS,
        remaining_credits: 0  // Credits are tracked in credit_purchases table only
      }])
      .select()
      .single();

    if (subError) {
      console.error('[Coupon] Failed to create subscription:', subError);
      throw subError;
    }

    console.log('[Coupon] Subscription created successfully');

    // Create credit purchase record (same as Stripe webhook does)
    console.log('[Coupon] Creating credit purchase...');
    
    const purchaseData = {
      user_id: user.id,
      subscription_id: subscription.id,
      credits: PRO_CREDITS,
      remaining_credits: PRO_CREDITS,
      amount_paid: 0, // Free with coupon
      currency: 'USD',
      stripe_payment_intent_id: 'COUPON_PAYMENT_' + Date.now(),
      stripe_checkout_session_id: 'COUPON_SESSION_' + Date.now(),
      purchase_type: 'subscription',
      expires_at: currentPeriodEnd.toISOString(),
      payment_status: 'completed'
    };
    
    console.log('[Coupon] Purchase data:', purchaseData);

    const { data: purchase, error: purchaseError } = await supabaseAdmin
      .from('credit_purchases')
      .insert([purchaseData])
      .select()
      .single();

    if (purchaseError) {
      console.error('[Coupon] Purchase creation failed:', purchaseError);
      throw purchaseError;
    }

    console.log('[Coupon] Credit purchase created successfully');

    // Update user tier to pro (same as Stripe webhook does)
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({ tier: 'pro' })
      .eq('id', user.id);
    
    if (updateError) {
      console.error('[Coupon] Failed to update user tier:', updateError);
    }

    // Log subscription history (same as Stripe webhook does)
    await supabaseAdmin
      .from('subscription_history')
      .insert([{
        subscription_id: subscription.id,
        user_id: user.id,
        event_type: 'created',
        stripe_event_id: 'COUPON_REDEEM_' + Date.now(),
        details: { coupon_code: coupon_code }
      }]);

    // Calculate total available credits
    console.log('[Coupon] Calculating available credits...');
    let availableCredits = PRO_CREDITS; // We just added this amount

    console.log('[Coupon] Redemption successful, returning response...');
    
    return res.status(200).json({
      success: true,
      message: `Successfully activated Pro subscription! You now have ${PRO_CREDITS} credits valid for ${PRO_VALIDITY_DAYS} days.`,
      subscription,
      purchase,
      available_credits: availableCredits
    });

  } catch (error) {
    console.error('Coupon redemption error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      details: error.details
    });
    
    // Return more specific error message
    if (error.code === '23505') {
      return res.status(400).json({ error: 'You have already redeemed this coupon' });
    }
    
    return res.status(500).json({ 
      error: 'Failed to redeem coupon. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};