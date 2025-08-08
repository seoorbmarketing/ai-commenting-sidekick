const { supabaseAdmin } = require('../lib/supabase');
const { 
  rateLimit, 
  validateImageData, 
  sanitizeInput, 
  configureCORS, 
  logSecurityEvent,
  sanitizeError
} = require('../lib/security');
const OpenAI = require('openai');

// Initialize OpenAI with API key from environment
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Verify OpenAI API key exists
if (!process.env.OPENAI_API_KEY) {
  console.error('[CRITICAL] OpenAI API key not configured');
  process.exit(1);
}

module.exports = async (req, res) => {
  // Configure CORS
  if (!configureCORS(req, res)) {
    logSecurityEvent('CORS_BLOCKED', { 
      origin: req.headers.origin,
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress 
    });
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.replace('Bearer ', '');
  let user;

  try {
    // Verify user authentication
    const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !userData.user) {
      logSecurityEvent('AUTH_FAILED', { token: token.substring(0, 10) + '...' });
      return res.status(401).json({ error: 'Authentication failed' });
    }
    
    user = userData.user;
    
    // Rate limiting
    const rateLimitResult = await rateLimit(user.id, 'analyze');
    if (!rateLimitResult.allowed) {
      logSecurityEvent('RATE_LIMIT_EXCEEDED', { userId: user.id });
      return res.status(429).json({ 
        error: 'Too many requests, please try again later',
        retryAfter: rateLimitResult.retryAfter 
      });
    }

    // Validate request body
    const { imageDataUrl, context, systemPrompt, userApiKey } = req.body;

    // Validate image data
    const imageValidation = validateImageData(imageDataUrl);
    if (!imageValidation.valid) {
      logSecurityEvent('INVALID_IMAGE_DATA', { 
        userId: user.id, 
        error: imageValidation.error 
      });
      return res.status(400).json({ error: imageValidation.error });
    }

    // Sanitize text inputs
    const sanitizedContext = sanitizeInput(context);
    const sanitizedSystemPrompt = sanitizeInput(systemPrompt);

    // Check if user is using their own API key or credits
    const isUsingOwnApiKey = !!userApiKey;
    
    if (!isUsingOwnApiKey) {
      // Check available credits from credit_purchases table only
      const now = new Date().toISOString();
      const { data: activePurchases } = await supabaseAdmin
        .from('credit_purchases')
        .select('remaining_credits')
        .eq('user_id', user.id)
        .gt('expires_at', now)
        .gt('remaining_credits', 0);

      const availableCredits = activePurchases 
        ? activePurchases.reduce((sum, p) => sum + p.remaining_credits, 0)
        : 0;

      if (!availableCredits || availableCredits < 1) {
        return res.status(402).json({ 
          error: 'Insufficient credits', 
          available_credits: 0 
        });
      }
    }

    // Default system prompt with sanitization
    const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant that creates engaging social media comments and responses. 
Your responses should be:
- Friendly and conversational
- Relevant to the content shown
- Concise (1-3 sentences usually)
- Appropriate for the platform context
Never use quotation marks around your response.`;

    // Prepare OpenAI request
    const messages = [
      {
        role: 'system',
        content: sanitizedSystemPrompt || DEFAULT_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: sanitizedContext || 'Please analyze this image and provide an appropriate response.'
          },
          {
            type: 'image_url',
            image_url: {
              url: imageDataUrl,
              detail: 'high'
            }
          }
        ]
      }
    ];

    // Use user's API key if provided, otherwise use system key
    const openaiClient = isUsingOwnApiKey ? new OpenAI({ apiKey: userApiKey }) : openai;
    
    // Call OpenAI API
    logSecurityEvent('OPENAI_REQUEST', { userId: user.id, usingOwnKey: isUsingOwnApiKey });
    
    const completion = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      max_tokens: 300,
      temperature: 0.7,
      user: user.id // For OpenAI's abuse monitoring
    });

    const aiResponse = completion.choices[0].message.content;
    const tokensUsed = completion.usage?.total_tokens || 0;

    // Use credits (with transaction safety)
    let purchaseId = null;
    let subscriptionId = null;
    
    if (!isUsingOwnApiKey) {
      // First check if user has credits - query directly like credits.js does
      const now = new Date().toISOString();
      const { data: activePurchases, error: checkError } = await supabaseAdmin
        .from('credit_purchases')
        .select('remaining_credits, expires_at')
        .eq('user_id', user.id)
        .gt('remaining_credits', 0)
        .or(`expires_at.is.null,expires_at.gt.${now}`);
      
      console.log('[Analyze] Credit check:', {
        userId: user.id,
        purchases: activePurchases,
        error: checkError
      });
      
      const availableCredits = activePurchases?.reduce((sum, p) => sum + p.remaining_credits, 0) || 0;
      
      if (checkError || availableCredits < 1) {
        console.error('Insufficient credits:', {
          checkError,
          availableCredits,
          activePurchases,
          userId: user.id
        });
        return res.status(402).json({ 
          error: 'Insufficient credits. Please add more credits to continue.',
          available_credits: availableCredits,
          debug: { purchaseCount: activePurchases?.length || 0 }
        });
      }
      
      const { data: creditResult, error: creditError } = await supabaseAdmin
        .rpc('use_credits', { 
          p_user_id: user.id, 
          p_credits_to_use: 1,
          p_api_key_used: false 
        });

      if (creditError || !creditResult || !creditResult[0]?.success) {
        logSecurityEvent('CREDIT_DEDUCTION_FAILED', { 
          userId: user.id, 
          error: creditError,
          result: creditResult
        });
        console.error('Credit deduction failed:', {
          error: creditError,
          result: creditResult,
          userId: user.id
        });
        
        // Provide more specific error message
        const errorMessage = creditResult?.[0]?.error_message || 
                           creditError?.message || 
                           'Failed to process credits. Please try again.';
        
        // Fail the request if credits can't be deducted
        return res.status(500).json({ 
          error: errorMessage,
          details: creditError?.details || 'Credit deduction failed'
        });
      }

      purchaseId = creditResult?.[0]?.purchase_id;
      subscriptionId = creditResult?.[0]?.subscription_id;
    }

    // Log usage (without storing sensitive data)
    const { error: logError } = await supabaseAdmin
      .from('api_usage')
      .insert([{
        user_id: user.id,
        purchase_id: purchaseId,
        subscription_id: subscriptionId,
        context: sanitizedContext ? sanitizedContext.substring(0, 100) : null, // Store only first 100 chars
        ai_response: aiResponse.substring(0, 200), // Store only first 200 chars
        credits_used: 1,
        api_key_used: isUsingOwnApiKey
      }]);

    if (logError) {
      console.error('Usage log error:', logError);
    }

    // Get updated credits from credit_purchases table only
    const now = new Date().toISOString();
    const { data: updatedPurchases } = await supabaseAdmin
      .from('credit_purchases')
      .select('remaining_credits')
      .eq('user_id', user.id)
      .gt('expires_at', now)
      .gt('remaining_credits', 0);

    const updatedCredits = updatedPurchases 
      ? updatedPurchases.reduce((sum, p) => sum + p.remaining_credits, 0)
      : 0;

    // Success response
    return res.status(200).json({
      success: true,
      response: aiResponse,
      remaining_credits: updatedCredits || 0,
      tokens_used: tokensUsed
    });

  } catch (error) {
    logSecurityEvent('API_ERROR', { 
      userId: user?.id,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    
    // Handle specific errors
    if (error.status === 429) {
      return res.status(429).json({ 
        error: 'OpenAI rate limit exceeded. Please try again later.' 
      });
    }
    
    if (error.status === 401) {
      // This should never happen if API key is correct
      console.error('[CRITICAL] OpenAI API authentication failed');
      return res.status(500).json({ 
        error: 'Service temporarily unavailable' 
      });
    }
    
    // Generic error response (don't leak details)
    return res.status(500).json({ 
      error: sanitizeError(error) 
    });
  }
};