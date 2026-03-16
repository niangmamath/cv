const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    role: { type: String, required: true, enum: ['job_seeker', 'recruiter'] },
    price: { type: String, required: true },
    priceDesc: { type: String, default: '' },
    analysisLimit: { type: Number, required: true },
    features: [String],
    badge: { type: String, default: '' }, // e.g., 'Populaire', 'Meilleure Valeur'
    ctaText: { type: String, default: 'Choisir ce plan' },
    ctaLink: { type: String, required: true },
    isCtaOutline: { type: Boolean, default: false },
    displayOrder: { type: Number, default: 99 }
});

const Plan = mongoose.model('Plan', planSchema);

module.exports = Plan;
