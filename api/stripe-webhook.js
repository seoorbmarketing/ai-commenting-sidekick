const { supabaseAdmin } = require('../lib/supabase');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Helper to get raw body for webhook verification
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(Buffer.from(data));
    });
    req.on('error', reject);
  });
}

// Webhook endpoint for Stripe events with raw body parsing
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return res.status(400).json({ error: 'Missing signature or webhook secret' });
  }

  let event;
  
  try {
    // Get raw body
    const rawBody = await getRawBody(req);
    
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.error('[Stripe Webhook] Verification failed:', err.message);
    return res.status(400).json({ error: `Webhook verification failed: ${err.message}` });
  }

  console.log('[Stripe Webhook] Event received:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object);
        break;

      default:
        console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Stripe Webhook] Error processing event:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};

async function handleCheckoutCompleted(session) {
  console.log('[Stripe Webhook] Processing checkout completion:', session.id);

  const { 
    user_id: userId, 
    purchase_type: purchaseType,
    credits: metadataCredits,
    validity_days: metadataValidityDays
  } = session.metadata || {};

  if (!userId) {
    console.error('[Stripe Webhook] No user_id in session metadata');
    return;
  }

  // Get or create stripe customer
  let stripeCustomerId = session.customer;
  
  if (!stripeCustomerId && session.customer_email) {
    // Create customer if not exists
    const customer = await stripe.customers.create({
      email: session.customer_email,
      metadata: { user_id: userId }
    });
    stripeCustomerId = customer.id;
  }

  // Update user with stripe customer ID
  await supabaseAdmin
    .from('users')
    .update({ stripe_customer_id: stripeCustomerId })
    .eq('id', userId);

  if (purchaseType === 'subscription') {
    // Initial subscription payment
    console.log('[Stripe Webhook] Processing initial subscription payment');
    
    // Get credits and validity from metadata or environment
    const credits = parseInt(metadataCredits || process.env.PRO_CREDITS_PER_MONTH || '200');
    const validityDays = parseInt(metadataValidityDays || process.env.PRO_VALIDITY_DAYS || '30');
    
    // Create subscription record
    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .insert([{
        user_id: userId,
        stripe_subscription_id: session.subscription,
        stripe_customer_id: stripeCustomerId,
        stripe_price_id: process.env.STRIPE_PRICE_ID,
        status: 'active',
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000).toISOString(),
        credits_per_period: credits,
        remaining_credits: 0  // Credits are tracked in credit_purchases table only
      }])
      .select()
      .single();

    if (subError) {
      console.error('[Stripe Webhook] Failed to create subscription:', subError);
      return;
    }

    // Create credit purchase record
    await supabaseAdmin
      .from('credit_purchases')
      .insert([{
        user_id: userId,
        subscription_id: subscription.id,
        credits: credits,
        remaining_credits: credits,
        amount_paid: session.amount_total / 100,
        currency: session.currency,
        stripe_payment_intent_id: session.payment_intent,
        stripe_checkout_session_id: session.id,
        purchase_type: 'subscription',
        expires_at: subscription.current_period_end,
        payment_status: 'completed'
      }]);

    // Update user tier
    await supabaseAdmin
      .from('users')
      .update({ tier: 'pro' })
      .eq('id', userId);

    // Log subscription history
    await supabaseAdmin
      .from('subscription_history')
      .insert([{
        subscription_id: subscription.id,
        user_id: userId,
        event_type: 'created',
        stripe_event_id: session.id,
        details: { session }
      }]);

  } else if (purchaseType === 'topup') {
    // Top-up purchase
    console.log('[Stripe Webhook] Processing top-up payment');

    // Get credits from metadata or environment
    const topupCredits = parseInt(metadataCredits || process.env.TOPUP_CREDITS || '100');

    // Get active subscription
    const { data: activeSubscription } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (!activeSubscription) {
      console.error('[Stripe Webhook] No active subscription for top-up');
      return;
    }

    // Create credit purchase record
    await supabaseAdmin
      .from('credit_purchases')
      .insert([{
        user_id: userId,
        subscription_id: activeSubscription.id,
        credits: topupCredits,
        remaining_credits: topupCredits,
        amount_paid: session.amount_total / 100,
        currency: session.currency,
        stripe_payment_intent_id: session.payment_intent,
        stripe_checkout_session_id: session.id,
        purchase_type: 'topup',
        expires_at: activeSubscription.current_period_end,
        payment_status: 'completed'
      }]);
  }
}

async function handleSubscriptionUpdate(subscription) {
  console.log('[Stripe Webhook] Updating subscription:', subscription.id);

  const { data: existingSubscription } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('stripe_subscription_id', subscription.id)
    .single();

  if (!existingSubscription) {
    console.log('[Stripe Webhook] Subscription not found, skipping update');
    return;
  }

  // Update subscription status
  const status = subscription.status === 'active' ? 'active' : 
                 subscription.status === 'past_due' ? 'past_due' :
                 subscription.status === 'canceled' ? 'cancelled' : 'expired';

  await supabaseAdmin
    .from('subscriptions')
    .update({
      status,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end
    })
    .eq('stripe_subscription_id', subscription.id);

  // Log history
  await supabaseAdmin
    .from('subscription_history')
    .insert([{
      subscription_id: existingSubscription.id,
      user_id: existingSubscription.user_id,
      event_type: 'updated',
      stripe_event_id: subscription.id,
      details: { subscription }
    }]);
}

async function handleSubscriptionDeleted(subscription) {
  console.log('[Stripe Webhook] Subscription cancelled:', subscription.id);

  const { data: existingSubscription } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('stripe_subscription_id', subscription.id)
    .single();

  if (!existingSubscription) {
    return;
  }

  // Update subscription status
  await supabaseAdmin
    .from('subscriptions')
    .update({ status: 'cancelled' })
    .eq('stripe_subscription_id', subscription.id);

  // Update user tier
  await supabaseAdmin
    .from('users')
    .update({ tier: 'free' })
    .eq('id', existingSubscription.user_id);

  // Log history
  await supabaseAdmin
    .from('subscription_history')
    .insert([{
      subscription_id: existingSubscription.id,
      user_id: existingSubscription.user_id,
      event_type: 'cancelled',
      stripe_event_id: subscription.id,
      details: { subscription }
    }]);
}

async function handleInvoicePaymentSucceeded(invoice) {
  console.log('[Stripe Webhook] Invoice payment succeeded:', invoice.id);

  // Handle subscription renewal
  if (invoice.subscription) {
    const { data: subscription } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('stripe_subscription_id', invoice.subscription)
      .single();

    if (subscription && invoice.billing_reason === 'subscription_cycle') {
      // Update subscription status (credits are tracked in credit_purchases only)
      await supabaseAdmin
        .from('subscriptions')
        .update({ 
          remaining_credits: 0,  // Credits are tracked in credit_purchases table only
          status: 'active'
        })
        .eq('id', subscription.id);

      // Create new credit purchase record for the renewal
      await supabaseAdmin
        .from('credit_purchases')
        .insert([{
          user_id: subscription.user_id,
          subscription_id: subscription.id,
          credits: subscription.credits_per_period,
          remaining_credits: subscription.credits_per_period,
          amount_paid: invoice.amount_paid / 100,
          currency: invoice.currency,
          stripe_payment_intent_id: invoice.payment_intent,
          purchase_type: 'subscription',
          expires_at: new Date(invoice.period_end * 1000).toISOString(),
          payment_status: 'completed'
        }]);

      // Log renewal
      await supabaseAdmin
        .from('subscription_history')
        .insert([{
          subscription_id: subscription.id,
          user_id: subscription.user_id,
          event_type: 'renewed',
          stripe_event_id: invoice.id,
          details: { invoice }
        }]);
    }
  }
}

async function handleInvoicePaymentFailed(invoice) {
  console.log('[Stripe Webhook] Invoice payment failed:', invoice.id);

  if (invoice.subscription) {
    const { data: subscription } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('stripe_subscription_id', invoice.subscription)
      .single();

    if (subscription) {
      // Update subscription status
      await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'past_due' })
        .eq('id', subscription.id);
    }
  }
}

// Disable body parsing to get raw body
module.exports.config = {
  api: {
    bodyParser: false,
  },
};