const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Read the Admin Key securely from Render Environment Variables
const ADMIN_SECRET_KEY = process.env.ADMIN_KEY || "DEFAULT_ADMIN_KEY_123";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure storage files exist
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const REGS_FILE = path.join(DATA_DIR, 'regs.json');
const PARTNERS_FILE = path.join(DATA_DIR, 'partners.json');

if (!fs.existsSync(REGS_FILE)) fs.writeFileSync(REGS_FILE, '[]');
if (!fs.existsSync(PARTNERS_FILE)) fs.writeFileSync(PARTNERS_FILE, '[]');

const readData = (file) => {
    try {
        const fileContent = fs.readFileSync(file, 'utf8');
        if (!fileContent || fileContent.trim() === "") return [];
        return JSON.parse(fileContent);
    } catch (error) {
        console.error(`Error reading or parsing ${file}:`, error);
        return [];
    }
};
const writeData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// 1. Get current registration price status (Early Bird check)
app.get('/api/status', (req, res) => {
    const regs = readData(REGS_FILE);
    const isEarlyBird = regs.length < 10;
    res.json({
        basePrice: isEarlyBird ? 700 : 1000,
        earlyBirdRemaining: Math.max(0, 10 - regs.length)
    });
});

// 2. Validate referral codes for discount calculation
app.post('/api/validate-code', (req, res) => {
    const { code } = req.body;
    const partners = readData(PARTNERS_FILE);
    const partner = partners.find(p => p.refCode === (code || '').toUpperCase().trim());

    if (!partner) {
        return res.json({ valid: false });
    }
    res.json({
        valid: true,
        type: partner.type, // 'AMB' (10% off) or 'ORG' (no student discount)
        discountPercent: partner.type === 'AMB' ? 10 : 0
    });
});

// 3. Register a student
app.post('/api/register', (req, res) => {
    const { name, phone, email, college, ticket, codeUsed, amountPaid } = req.body;

    if (!name || !phone || !email || !college || !ticket) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const regs = readData(REGS_FILE);
    const newEntry = {
        id: Date.now().toString(),
        name,
        phone,
        email,
        college,
        ticket,
        codeUsed: (codeUsed || '').toUpperCase().trim(),
        amountPaid: Number(amountPaid),
        status: "Pending",
        createdAt: new Date().toISOString()
    };

    regs.push(newEntry);
    writeData(REGS_FILE, regs);

    res.json({ success: true, entry: newEntry });
});

// 4. Secure Authentication (Checks Render Env Variable for Admin, or Partner keys)
app.post('/api/auth', (req, res) => {
    const { unlockCode } = req.body;
    const inputCode = (unlockCode || '').trim();

    if (inputCode === ADMIN_SECRET_KEY) {
        return res.json({ authenticated: true, role: 'ADMIN' });
    }

    const partners = readData(PARTNERS_FILE);
    const partner = partners.find(p => p.unlockCode === inputCode);

    if (partner) {
        return res.json({ authenticated: true, role: partner.type, partner });
    }

    res.status(401).json({ authenticated: false, message: "Invalid Access Code" });
});

// 5. Admin Data Fetch
app.get('/api/admin/data', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    const regs = readData(REGS_FILE);
    const partners = readData(PARTNERS_FILE);

    // Calculate payouts
    const settlements = partners.map(p => {
        const partnerRegs = regs.filter(r => r.codeUsed === p.refCode);
        const successful = partnerRegs.filter(r => r.status === 'Successful');

        let payout = 0;
        if (p.type === 'AMB' && successful.length >= 1) {
            payout = 100;
        } else if (p.type === 'ORG') {
            payout = successful.reduce((sum, r) => sum + (r.amountPaid * 0.30), 0);
        }

        return {
            name: p.name,
            type: p.type,
            refCode: p.refCode,
            totalReferrals: partnerRegs.length,
            verifiedSuccess: successful.length,
            payoutOwed: payout
        };
    });

    res.json({ regs, settlements });
});

// 6. Admin Status Update
app.post('/api/admin/update-status', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    const { id, status } = req.body;
    const regs = readData(REGS_FILE);
    const index = regs.findIndex(r => r.id === id);

    if (index !== -1) {
        regs[index].status = status;
        writeData(REGS_FILE, regs);
        return res.json({ success: true });
    }

    res.status(404).json({ error: "Record not found" });
});

// 7. Admin Register Partner
app.post('/api/admin/create-partner', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    const { type, name } = req.body;
    const partners = readData(PARTNERS_FILE);
    const randomSuffix = Math.floor(10000 + Math.random() * 90000);

    const refCode = `${type}-${name.substring(0, 3).toUpperCase()}${randomSuffix}`;
    const unlockCode = `KEY-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

    const newPartner = { type, name, refCode, unlockCode };
    partners.push(newPartner);
    writeData(PARTNERS_FILE, partners);

    res.json({ success: true, partner: newPartner });
});

// 8. Partner Fetch Data
app.post('/api/partner/data', (req, res) => {
    const { unlockCode } = req.body;
    const partners = readData(PARTNERS_FILE);
    const partner = partners.find(p => p.unlockCode === (unlockCode || '').trim());

    if (!partner) return res.status(401).json({ error: "Unauthorized" });

    const regs = readData(REGS_FILE);
    const referredStudents = regs
        .filter(r => r.codeUsed === partner.refCode)
        .map(r => ({
            name: r.name,
            ticket: r.ticket,
            amountPaid: r.amountPaid,
            status: r.status
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
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));