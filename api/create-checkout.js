const { supabaseAdmin } = require('../lib/supabase');

// Validate Stripe configuration
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('[CreateCheckout] STRIPE_SECRET_KEY is missing');
  throw new Error('Stripe configuration error: STRIPE_SECRET_KEY is required');
}

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Log configuration status
console.log('[CreateCheckout] Configuration check:', {
  hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
  hasStripePriceId: !!process.env.STRIPE_PRICE_ID,
  hasFrontendUrl: !!process.env.FRONTEND_URL,
  hasChromeExtensionId: !!process.env.CHROME_EXTENSION_ID
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
    console.error('[CreateCheckout] No authorization header provided');
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { type } = req.body; // 'subscription' or 'topup'
  
  console.log('[CreateCheckout] Request received:', {
    hasAuth: !!authHeader,
    type: type,
    bodyKeys: Object.keys(req.body || {})
  });
  
  if (!type) {
    return res.status(400).json({ error: 'Purchase type is required' });
  }

  try {
    // Verify the user
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      console.error('[CreateCheckout] Auth error:', authError);
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user data
    let { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (userError || !userData) {
      console.error('[CreateCheckout] User not found, creating profile');
      
      // Create user profile if it doesn't exist
      const { data: newUser, error: createError } = await supabaseAdmin
        .from('users')
        .insert([{
          id: user.id,
          email: user.email,
          tier: 'free'
        }])
        .select()
        .single();
      
      if (createError) {
        console.error('[CreateCheckout] Failed to create user profile:', createError);
        return res.status(500).json({ error: 'Failed to create user profile' });
      }
      
      userData = newUser;
    }

    // For top-ups, check if user has active subscription
    if (type === 'topup') {
      const { data: activeSubscription } = await supabaseAdmin
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .gt('current_period_end', new Date().toISOString())
        .single();

      if (!activeSubscription) {
        return res.status(400).json({ error: 'No active subscription found. Top-ups require an active subscription.' });
      }
    }

    // Create or get Stripe customer
    let stripeCustomerId = userData.stripe_customer_id;
    
    if (!stripeCustomerId) {
      console.log('[CreateCheckout] Creating new Stripe customer for:', user.email);
      
      try {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: {
            user_id: user.id
          }
        });
        
        stripeCustomerId = customer.id;
        console.log('[CreateCheckout] Created Stripe customer:', stripeCustomerId);
        
        // Update user with stripe customer ID
        const { error: updateError } = await supabaseAdmin
          .from('users')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', user.id);
          
        if (updateError) {
          console.error('[CreateCheckout] Failed to update user with Stripe customer ID:', updateError);
        }
      } catch (customerError) {
        console.error('[CreateCheckout] Failed to create Stripe customer:', customerError);
        throw new Error(`Failed to create payment customer: ${customerError.message}`);
      }
    } else {
      console.log('[CreateCheckout] Using existing Stripe customer:', stripeCustomerId);
    }

    // Create checkout session
    // For Chrome extensions, we need to use the extension ID
    const extensionId = process.env.CHROME_EXTENSION_ID || 'YOUR_EXTENSION_ID';
    // Ensure proper chrome-extension:// protocol format
    const baseUrl = process.env.FRONTEND_URL || `chrome-extension://${extensionId}`;
    
    // Log the URLs being used
    console.log('[CreateCheckout] Using URLs:', {
      baseUrl,
      successUrl: `${baseUrl}/payment-success.html?session_id={CHECKOUT_SESSION_ID}&type=${type}`,
      cancelUrl: `${baseUrl}/payment-cancel.html?type=${type}`
    });
    
    const sessionConfig = {
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      mode: type === 'subscription' ? 'subscription' : 'payment',
      success_url: `${baseUrl}/payment-success.html?session_id={CHECKOUT_SESSION_ID}&type=${type}`,
      cancel_url: `${baseUrl}/payment-cancel.html?type=${type}`,
      metadata: {
        user_id: user.id,
        purchase_type: type
      }
    };

    // Get pricing from environment variables
    const PRO_CREDITS = parseInt(process.env.PRO_CREDITS_PER_MONTH || '200');
    const PRO_VALIDITY_DAYS = parseInt(process.env.PRO_VALIDITY_DAYS || '30');
    const TOPUP_CREDITS = parseInt(process.env.TOPUP_CREDITS || '100');
    const TOPUP_PRICE_CENTS = parseInt(process.env.TOPUP_PRICE_CENTS || '297');

    if (type === 'subscription') {
      // Validate STRIPE_PRICE_ID exists
      if (!process.env.STRIPE_PRICE_ID) {
        console.error('[CreateCheckout] STRIPE_PRICE_ID is missing for subscription');
        return res.status(500).json({ 
          error: 'Configuration error: STRIPE_PRICE_ID is required for subscriptions' 
        });
      }
      
      // Pro subscription
      sessionConfig.line_items = [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1
      }];
      sessionConfig.metadata.description = `Pro Subscription - ${PRO_CREDITS} credits for ${PRO_VALIDITY_DAYS} days`;
      sessionConfig.metadata.credits = PRO_CREDITS.toString();
      sessionConfig.metadata.validity_days = PRO_VALIDITY_DAYS.toString();
    } else if (type === 'topup') {
      // Top-up
      sessionConfig.line_items = [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Credit Top-up',
            description: `${TOPUP_CREDITS} additional credits for your active subscription`
          },
          unit_amount: TOPUP_PRICE_CENTS
        },
        quantity: 1
      }];
      sessionConfig.metadata.description = `Credit Top-up - ${TOPUP_CREDITS} credits`;
      sessionConfig.metadata.credits = TOPUP_CREDITS.toString();
    } else {
      return res.status(400).json({ error: 'Invalid purchase type' });
    }

    console.log('[CreateCheckout] Creating session with config:', {
      mode: sessionConfig.mode,
      lineItemsCount: sessionConfig.line_items?.length,
      hasSuccessUrl: !!sessionConfig.success_url,
      hasCancelUrl: !!sessionConfig.cancel_url,
      type: type,
      customer: sessionConfig.customer,
      priceId: type === 'subscription' ? process.env.STRIPE_PRICE_ID : 'dynamic'
    });

    // Validate before creating session
    if (type === 'subscription' && !sessionConfig.line_items?.[0]?.price) {
      throw new Error('Invalid Stripe configuration: Price ID is missing or invalid');
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    console.log('[CreateCheckout] Session created successfully:', session.id);

    return res.status(200).json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id
    });

  } catch (error) {
    console.error('[CreateCheckout] Stripe error details:', {
      message: error.message,
      type: error.type,
      code: error.code,
      statusCode: error.statusCode,
      param: error.param,
      detail: error.detail,
      requestId: error.requestId
    });
    
    // Provide more specific error messages based on error type
    let errorMessage = 'Failed to create checkout session';
    if (error.type === 'StripeInvalidRequestError') {
      errorMessage = `Stripe configuration error: ${error.message}`;
    } else if (error.type === 'StripeAPIError') {
      errorMessage = 'Stripe API error - please try again';
    } else if (error.type === 'StripeConnectionError') {
      errorMessage = 'Connection to payment service failed';
    }
    
    return res.status(500).json({ 
      error: errorMessage,
      details: error.message,
      code: error.code
    });
  }
};