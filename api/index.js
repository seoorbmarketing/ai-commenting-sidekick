module.exports = (req, res) => {
  // Return API info
  res.status(200).json({
    name: 'AI Commenting Sidekick API',
    version: '1.0.0',
    status: 'operational',
    endpoints: {
      health: '/api/health',
      auth: '/api/auth',
      analyze: '/api/analyze',
      credits: '/api/credits',
      redeemCoupon: '/api/redeem-coupon'
    },
    documentation: 'https://github.com/seoorbmarketing/ai-commenting-sidekick'
  });
};