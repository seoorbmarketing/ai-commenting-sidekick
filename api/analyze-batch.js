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
    
    // Rate limiting - count as single request for batch
    const rateLimitResult = await rateLimit(user.id, 'analyze-batch');
    if (!rateLimitResult.allowed) {
      logSecurityEvent('RATE_LIMIT_EXCEEDED', { userId: user.id });
      return res.status(429).json({ 
        error: 'Too many requests, please try again later',
        retryAfter: rateLimitResult.retryAfter 
      });
    }

    // Validate request body
    const { images, context, systemPrompt, userApiKey } = req.body;

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Images array is required' });
    }

    if (images.length > 4) {
      return res.status(400).json({ error: 'Maximum 4 images allowed per batch' });
    }

    // Validate all images
    for (let i = 0; i < images.length; i++) {
      const imageValidation = validateImageData(images[i]);
      if (!imageValidation.valid) {
        logSecurityEvent('INVALID_IMAGE_DATA', { 
          userId: user.id, 
          error: imageValidation.error,
          imageIndex: i
        });
        return res.status(400).json({ 
          error: `Image ${i + 1}: ${imageValidation.error}` 
        });
      }
    }

    // Sanitize text inputs
    const sanitizedContext = sanitizeInput(context);
    const sanitizedSystemPrompt = sanitizeInput(systemPrompt);

    // Check if user is using their own API key or credits
    const isUsingOwnApiKey = !!userApiKey;
    
    if (!isUsingOwnApiKey) {
      // Check available credits
      const now = new Date().toISOString();
      const { data: activePurchases } = await supabaseAdmin
        .from('credit_purchases')
        .select('remaining_credits')
        .eq('user_id', user.id)
        .gt('remaining_credits', 0)
        .or(`expires_at.is.null,expires_at.gt.${now}`);

      const availableCredits = activePurchases 
        ? activePurchases.reduce((sum, p) => sum + p.remaining_credits, 0)
        : 0;

      if (availableCredits < images.length) {
        return res.status(402).json({ 
          error: `Insufficient credits. Need ${images.length}, have ${availableCredits}`, 
          available_credits: availableCredits,
          required_credits: images.length
        });
      }
    }

    // Default system prompt
    const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant that creates engaging social media comments and responses. 
Your responses should be:
- Friendly and conversational
- Relevant to the content shown
- Concise (1-3 sentences usually)
- Appropriate for the platform context
Never use quotation marks around your response.`;

    // Use user's API key if provided, otherwise use system key
    const openaiClient = isUsingOwnApiKey ? new OpenAI({ apiKey: userApiKey }) : openai;
    
    // Process all images in parallel
    logSecurityEvent('OPENAI_BATCH_REQUEST', { 
      userId: user.id, 
      usingOwnKey: isUsingOwnApiKey,
      imageCount: images.length 
    });
    
    const analysisPromises = images.map(async (imageDataUrl, index) => {
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
              text: `${sanitizedContext || 'Please analyze this image and provide an appropriate response.'} (Image ${index + 1} of ${images.length})`
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

      const completion = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: messages,
        max_tokens: 300,
        temperature: 0.7,
        user: user.id // For OpenAI's abuse monitoring
      });

      return {
        response: completion.choices[0].message.content,
        tokensUsed: completion.usage?.total_tokens || 0,
        index: index
      };
    });

    const results = await Promise.all(analysisPromises);
    
    // Sort by index to maintain order
    results.sort((a, b) => a.index - b.index);
    
    // Deduct credits if not using own API key
    let remainingCredits = null;
    
    if (!isUsingOwnApiKey) {
      const now = new Date().toISOString();
      
      // Deduct credits for all images
      let creditsToDeduct = images.length;
      
      while (creditsToDeduct > 0) {
        // Find the oldest credit purchase with remaining credits
        const { data: creditPurchase, error: findError } = await supabaseAdmin
          .from('credit_purchases')
          .select('id, remaining_credits, subscription_id')
          .eq('user_id', user.id)
          .gt('remaining_credits', 0)
          .or(`expires_at.is.null,expires_at.gt.${now}`)
          .order('created_at', { ascending: true })
          .limit(1)
          .single();
        
        if (findError || !creditPurchase) {
          console.error('No valid credit purchase found:', findError);
          return res.status(402).json({ 
            error: 'Failed to deduct credits',
            details: findError?.message
          });
        }
        
        // Deduct as many credits as possible from this purchase
        const creditsFromThisPurchase = Math.min(creditsToDeduct, creditPurchase.remaining_credits);
        
        const { error: creditError } = await supabaseAdmin
          .from('credit_purchases')
          .update({ 
            remaining_credits: creditPurchase.remaining_credits - creditsFromThisPurchase,
            updated_at: new Date().toISOString()
          })
          .eq('id', creditPurchase.id);
        
        if (creditError) {
          console.error('Failed to deduct credit:', creditError);
          return res.status(500).json({ 
            error: 'Failed to deduct credit',
            details: creditError?.message
          });
        }
        
        creditsToDeduct -= creditsFromThisPurchase;
        
        // Log usage for each credit used
        for (let i = 0; i < creditsFromThisPurchase; i++) {
          const resultIndex = images.length - creditsToDeduct - creditsFromThisPurchase + i;
          const { error: logError } = await supabaseAdmin
            .from('api_usage')
            .insert([{
              user_id: user.id,
              purchase_id: creditPurchase.id,
              subscription_id: creditPurchase.subscription_id,
              context: sanitizedContext ? sanitizedContext.substring(0, 100) : null,
              ai_response: results[resultIndex].response.substring(0, 200),
              credits_used: 1,
              api_key_used: false
            }]);
          
          if (logError) {
            console.error('Usage log error:', logError);
          }
        }
      }
      
      // Get updated credits
      const { data: updatedPurchases } = await supabaseAdmin
        .from('credit_purchases')
        .select('remaining_credits')
        .eq('user_id', user.id)
        .gt('remaining_credits', 0)
        .or(`expires_at.is.null,expires_at.gt.${now}`);

      remainingCredits = updatedPurchases 
        ? updatedPurchases.reduce((sum, p) => sum + p.remaining_credits, 0)
        : 0;
    } else {
      // Log usage for user's own API key
      for (const result of results) {
        const { error: logError } = await supabaseAdmin
          .from('api_usage')
          .insert([{
            user_id: user.id,
            purchase_id: null,
            subscription_id: null,
            context: sanitizedContext ? sanitizedContext.substring(0, 100) : null,
            ai_response: result.response.substring(0, 200),
            credits_used: 0,
            api_key_used: true
          }]);
        
        if (logError) {
          console.error('Usage log error:', logError);
        }
      }
    }

    // Success response
    return res.status(200).json({
      success: true,
      responses: results.map(r => r.response),
      remaining_credits: remainingCredits,
      total_tokens_used: results.reduce((sum, r) => sum + r.tokensUsed, 0)
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
      console.error('[CRITICAL] OpenAI API authentication failed');
      return res.status(500).json({ 
        error: 'Service temporarily unavailable' 
      });
    }
    
    // Generic error response
    return res.status(500).json({ 
      error: sanitizeError(error) 
    });
  }
};