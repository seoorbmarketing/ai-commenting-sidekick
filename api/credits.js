const { supabaseAdmin } = require('../lib/supabase');

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

  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    // Verify user
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    switch (req.method) {
      case 'GET':
        return await handleGetCredits(user.id, res);
      case 'POST':
        return await handleAddCredits(user.id, req.body, res);
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Credits API] Error:', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });
    return res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

async function handleGetCredits(userId, res) {
  try {
    console.log('[Credits] Getting credits for user:', userId);
    
    // Get active purchases (not expired, with remaining credits)
    const now = new Date().toISOString();
    const { data: activePurchases, error: activeError } = await supabaseAdmin
      .from('credit_purchases')
      .select('*')
      .eq('user_id', userId)
      .gt('expires_at', now)
      .gt('remaining_credits', 0)
      .order('expires_at', { ascending: true });

    if (activeError) {
      console.error('[Credits] Error fetching active purchases:', activeError);
      throw activeError;
    }
    
    console.log('[Credits] Found active purchases:', activePurchases?.length || 0);

    // Get all purchases for history
    const { data: allPurchases, error: purchaseError } = await supabaseAdmin
      .from('credit_purchases')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (purchaseError) {
      throw purchaseError;
    }

    // Get usage stats
    const { count: totalUsage } = await supabaseAdmin
      .from('api_usage')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // Calculate total available credits from active purchases ONLY
    // (credit_purchases already includes subscription credits)
    let availableCredits = 0;
    if (activePurchases && activePurchases.length > 0) {
      availableCredits = activePurchases.reduce((sum, purchase) => sum + purchase.remaining_credits, 0);
    }
    
    console.log('[Credits] Total available credits:', availableCredits);

    // Calculate days until expiry for the earliest expiring pack
    let daysUntilExpiry = null;
    let nextExpiryDate = null;
    
    if (activePurchases && activePurchases.length > 0) {
      const earliestExpiry = new Date(activePurchases[0].expires_at);
      nextExpiryDate = earliestExpiry.toISOString();
      const now = new Date();
      const diffTime = earliestExpiry - now;
      daysUntilExpiry = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }

    return res.status(200).json({
      available_credits: availableCredits,
      active_purchases: activePurchases || [],
      all_purchases: allPurchases || [],
      total_usage: totalUsage || 0,
      days_until_expiry: daysUntilExpiry,
      next_expiry_date: nextExpiryDate
    });
  } catch (error) {
    console.error('[Get credits error]:', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });
    return res.status(500).json({ 
      error: 'Failed to get credits',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

async function handleAddCredits(userId, body, res) {
  // This will be used after payment is confirmed
  // For now, we'll create a manual credit addition for testing
  
  const { payment_id, test_mode } = body;

  try {
    // In production, verify payment with Razorpay here
    // For testing, allow manual credit addition
    if (!test_mode && !payment_id) {
      return res.status(400).json({ error: 'Payment ID required' });
    }

    // Calculate expiry date (30 days from now)
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);

    // Add credit purchase
    const { data: purchase, error: purchaseError } = await supabaseAdmin
      .from('credit_purchases')
      .insert([{
        user_id: userId,
        credits: 200,
        remaining_credits: 200,
        amount_paid: 5.00,
        currency: 'INR',
        expires_at: expiryDate.toISOString(),
        stripe_payment_intent_id: payment_id || 'TEST_' + Date.now(),
        payment_status: test_mode ? 'completed' : 'pending'
      }])
      .select()
      .single();

    if (purchaseError) {
      throw purchaseError;
    }

    // Get updated available credits
    const { data: updatedPurchases } = await supabaseAdmin
      .from('credit_purchases')
      .select('remaining_credits')
      .eq('user_id', userId)
      .gt('expires_at', new Date().toISOString())
      .gt('remaining_credits', 0);

    const availableCredits = updatedPurchases 
      ? updatedPurchases.reduce((sum, p) => sum + p.remaining_credits, 0)
      : 0;

    return res.status(200).json({
      success: true,
      purchase,
      available_credits: availableCredits
    });
  } catch (error) {
    console.error('Add credits error:', error);
    return res.status(500).json({ error: 'Failed to add credits' });
  }
}