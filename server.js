const express = require('express');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// Read Environment Variables
const ADMIN_SECRET_KEY = process.env.ADMIN_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Successfully connected to MongoDB'))
    .catch((err) => console.error('MongoDB connection error:', err));

// -----------------------------------------
// DATABASE SCHEMAS
// -----------------------------------------
const regSchema = new mongoose.Schema({
    name: String,
    phone: String,
    email: String,
    college: String,
    ticket: String,
    codeUsed: String,
    amountPaid: Number,
    status: { type: String, default: "Pending" }, // Pending, Successful, Rejected
    createdAt: { type: Date, default: Date.now }
});
const Reg = mongoose.model('Reg', regSchema);

const partnerSchema = new mongoose.Schema({
    type: String, // 'AMB' or 'ORG'
    name: String,
    refCode: String,
    unlockCode: String
});
const Partner = mongoose.model('Partner', partnerSchema);

// -----------------------------------------
// API ENDPOINTS
// -----------------------------------------

// 1. Get current registration price status
app.get('/api/status', async (req, res) => {
    try {
        const activeCount = await Reg.countDocuments({ status: { $ne: 'Rejected' } });
        const isEarlyBird = activeCount < 10;
        res.json({
            basePrice: isEarlyBird ? 700 : 1000,
            earlyBirdRemaining: Math.max(0, 10 - activeCount)
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

// 2. Validate referral codes (Strict 5% for AMB, 0% for ORG)
app.post('/api/validate-code', async (req, res) => {
    try {
        const { code } = req.body;
        const partner = await Partner.findOne({ refCode: (code || '').toUpperCase().trim() });

        if (!partner) return res.json({ valid: false });
        
        res.json({
            valid: true,
            type: partner.type,
            discountPercent: partner.type === 'AMB' ? 5 : 0 
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

// 3. Register a student (Rejects fake codes backend-side)
app.post('/api/register', async (req, res) => {
    try {
        const { name, phone, email, college, ticket, codeUsed, amountPaid } = req.body;
        if (!name || !phone || !email || !college || !ticket) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const submittedCode = (codeUsed || '').toUpperCase().trim();
        const isValidCode = await Partner.findOne({ refCode: submittedCode });
        const finalCode = isValidCode ? submittedCode : ""; 

        const newEntry = new Reg({
            name, phone, email, college, ticket, 
            codeUsed: finalCode, amountPaid: Number(amountPaid)
        });

        await newEntry.save();
        res.json({ success: true, entry: newEntry });
    } catch (error) {
        res.status(500).json({ error: "Registration failed" });
    }
});

// 4. Secure Authentication 
app.post('/api/auth', async (req, res) => {
    try {
        const { unlockCode } = req.body;
        const inputCode = (unlockCode || '').trim();

        if (inputCode === ADMIN_SECRET_KEY) {
            return res.json({ authenticated: true, role: 'ADMIN' });
        }

        const partner = await Partner.findOne({ unlockCode: inputCode });
        if (partner) {
            return res.json({ authenticated: true, role: partner.type, partner });
        }

        res.status(401).json({ authenticated: false, message: "Invalid Access Code" });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

// 5. Admin Data Fetch
app.get('/api/admin/data', async (req, res) => {
    try {
        if (req.headers['authorization'] !== ADMIN_SECRET_KEY) return res.status(403).json({ error: "Unauthorized" });

        const regsRaw = await Reg.find().sort({ createdAt: -1 });
        const partners = await Partner.find();

        // Convert MongoDB _id to id so the frontend doesn't break
        const regs = regsRaw.map(r => ({ ...r.toObject(), id: r._id.toString() }));
        const activeRegs = regs.filter(r => r.status !== 'Rejected');
        
        const settlements = partners.map(p => {
            const partnerRegs = regs.filter(r => r.codeUsed === p.refCode && r.status === 'Successful');
            
            let payout = 0;
            if (p.type === 'AMB' && partnerRegs.length >= 1) {
                payout = 100;
            } else if (p.type === 'ORG') {
                payout = partnerRegs.reduce((sum, r) => sum + (r.amountPaid * 0.30), 0); 
            }

            const totalPartnerRefs = regs.filter(r => r.codeUsed === p.refCode && r.status !== 'Rejected').length;

            return {
                name: p.name, type: p.type, refCode: p.refCode, 
                totalReferrals: totalPartnerRefs, verifiedSuccess: partnerRegs.length, payoutOwed: payout
            };
        });

        res.json({ regs, settlements, activeCount: activeRegs.length });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

// 6. Admin Status Update
app.post('/api/admin/update-status', async (req, res) => {
    try {
        if (req.headers['authorization'] !== ADMIN_SECRET_KEY) return res.status(403).json({ error: "Unauthorized" });

        const { id, status } = req.body;
        await Reg.findByIdAndUpdate(id, { status });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to update" });
    }
});

// 7. Admin Register Partner
app.post('/api/admin/create-partner', async (req, res) => {
    try {
        if (req.headers['authorization'] !== ADMIN_SECRET_KEY) return res.status(403).json({ error: "Unauthorized" });

        const { type, name } = req.body;
        const randomSuffix = Math.floor(10000 + Math.random() * 90000);
        const refCode = `${type}-${name.substring(0, 3).toUpperCase()}${randomSuffix}`;
        const unlockCode = `KEY-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

        const newPartner = new Partner({ type, name, refCode, unlockCode });
        await newPartner.save();

        res.json({ success: true, partner: newPartner });
    } catch (error) {
        res.status(500).json({ error: "Failed to create partner" });
    }
});

// 8. Partner Fetch Data
app.post('/api/partner/data', async (req, res) => {
    try {
        const { unlockCode } = req.body;
        const partner = await Partner.findOne({ unlockCode: (unlockCode || '').trim() });

        if (!partner) return res.status(401).json({ error: "Unauthorized" });

        const regs = await Reg.find({ codeUsed: partner.refCode }).sort({ createdAt: -1 });
        
        const referredStudents = regs.map(r => ({
            name: r.name, ticket: r.ticket, amountPaid: r.amountPaid, status: r.status
        }));

        const successfulCount = referredStudents.filter(r => r.status === 'Successful').length;
        let earnings = 0;

        if (partner.type === 'AMB' && successfulCount >= 1) {
            earnings = 100;
        } else if (partner.type === 'ORG') {
            earnings = referredStudents
                .filter(r => r.status === 'Successful')
                .reduce((sum, r) => sum + (r.amountPaid * 0.30), 0);
        }

        res.json({ partner, referredStudents, earnings, successfulCount });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

// 9. Admin Delete Partner
app.post('/api/admin/delete-partner', async (req, res) => {
    try {
        if (req.headers['authorization'] !== ADMIN_SECRET_KEY) return res.status(403).json({ error: "Unauthorized" });

        const { refCode } = req.body;
        const deletedPartner = await Partner.findOneAndDelete({ refCode });

        if (deletedPartner) return res.json({ success: true });
        res.status(404).json({ error: "Partner not found" });
    } catch (error) {
        res.status(500).json({ error: "Failed to delete partner" });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));