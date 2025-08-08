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

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    // Verify the user
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      console.error('[GetUserData] Auth error:', authError);
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Since we're using service role, we need to query directly instead of using the RPC function
    // The RPC function relies on auth.uid() which won't work with service role
    let { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (userError || !userData) {
      console.error('[GetUserData] User not found, creating profile');
      
      // Create user profile if it doesn't exist (new signup)
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
        console.error('[GetUserData] Failed to create user profile:', createError);
        // Return a default response instead of error for new users
        return res.status(200).json({
          success: true,
          user: {
            id: user.id,
            email: user.email,
            tier: 'free'
          },
          credits: {
            available_credits: 0,
            total_usage: 0
          },
          subscription: null
        });
      }
      
      userData = newUser;
    }

    // Get subscription data
    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .gt('current_period_end', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);

    // Get available credits from credit_purchases
    const now = new Date().toISOString();
    const { data: activePurchases, error: creditsError } = await supabaseAdmin
      .from('credit_purchases')
      .select('remaining_credits')
      .eq('user_id', user.id)
      .gt('expires_at', now)
      .gt('remaining_credits', 0);

    const availableCredits = activePurchases 
      ? activePurchases.reduce((sum, p) => sum + p.remaining_credits, 0)
      : 0;
    
    console.log('[GetUserData] Credits calculation:', {
      userId: user.id,
      activePurchasesCount: activePurchases?.length || 0,
      totalAvailableCredits: availableCredits,
      purchases: activePurchases
    });

    // Calculate total usage
    const { data: totalUsage, error: usageError } = await supabaseAdmin
      .from('api_usage')
      .select('credits_used')
      .eq('user_id', user.id);

    const totalCreditsUsed = totalUsage?.reduce((sum, usage) => sum + (usage.credits_used || 0), 0) || 0;

    // Build subscription object
    let subscription = null;
    if (subscriptions && subscriptions.length > 0) {
      const activeSub = subscriptions[0];
      const daysRemaining = Math.ceil((new Date(activeSub.current_period_end) - new Date()) / (1000 * 60 * 60 * 24));
      
      subscription = {
        status: 'active',
        credits: activeSub.credits_per_period || 200,
        remaining_credits: availableCredits || 0,  // Use credits from credit_purchases table
        expires_at: activeSub.current_period_end,
        days_remaining: daysRemaining > 0 ? daysRemaining : 0
      };
    }

    return res.status(200).json({
      success: true,
      user: userData,
      credits: {
        available_credits: availableCredits || 0,
        total_usage: totalCreditsUsed
      },
      subscription
    });

  } catch (error) {
    console.error('[GetUserData] Unexpected error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
};