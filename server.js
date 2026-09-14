/* ================================================================
   ZOHO POS - Backend Proxy (server.js)
   Reads user-entered Zoho credentials from each request body.
   Run:  npm install express cors   →   node server.js
   ================================================================ */

   const express = require('express');
   const cors = require('cors');
   
   const app = express();
   app.use(cors());
   app.use(express.json());
   
   const PORT = 3001;
   
   /* ============ TOKEN MANAGEMENT (cached per refresh token) ============ */
   const tokenCache = {}; // key: refresh token → { token, expiry }
   
   async function getToken(cfg) {
       const key = cfg.refresh;
       const cached = tokenCache[key];
   
       if (cached && Date.now() < cached.expiry) {
           return cached.token;
       }
   
       const res = await fetch(`https://accounts.zoho.${cfg.region}/oauth/v2/token`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
           body: new URLSearchParams({
               refresh_token: cfg.refresh,
               client_id: cfg.clientId,
               client_secret: cfg.secret,
               grant_type: 'refresh_token'
           })
       });
   
       const data = await res.json();
   
       if (data.error) {
           throw new Error('Zoho auth failed: ' + data.error +
               (data.error === 'invalid_code' ? ' — generate a new token' : ''));
    }
   
       tokenCache[key] = {
           token: data.access_token,
           // refresh 60s before actual expiry
           expiry: Date.now() + ((data.expires_in || 3600) - 60) * 1000
       };
   
       return tokenCache[key].token;
   }
   
   /* Helper: call Zoho Inventory API with auth header */
   async function zohoFetch(cfg, path, options = {}) {
       const token = await getToken(cfg);

       const url = `https://www.zohoapis.${cfg.region}/inventory/v1/${path}` + (path.includes('?') ? '&' : '?') + `organization_id=${cfg.org}`;
   
       const res = await fetch(url, {
           ...options,
           headers: {
               Authorization: `Zoho-oauthtoken ${token}`,
               'Content-Type': 'application/json',
               ...(options.headers || {})
           }
       });
   
       const data = await res.json();
   
       // Access token revoked/expired mid-use → clear cache so next call re-auths
       if (res.status === 401) {
           delete tokenCache[cfg.refresh];
       }
   
       return { ok: res.ok, status: res.status, data };
   }
   
   /* ============ POST /api/zoho/test — validate credentials ============ */
   app.post('/api/zoho/test', async (req, res) => {
       try {
           const cfg = req.body;
           const { ok, data } = await zohoFetch(cfg, 'organizations');
           const org = (data.organizations || []).find(o => String(o.organization_id) === String(cfg.org));
   
           if (!ok || !org) {
               return res.status(401).json({
                   message: ok ? 'Organization ID not found for these credentials'
                               : (data.message || 'Invalid credentials')
               });
           }
           res.json({ org_name: org.name });
       } catch (e) {
           res.status(401).json({ message: e.message });
       }
   });
   
  /* ============ POST /api/zoho/items — load inventory ============ */
app.post('/api/zoho/items', async (req, res) => {
    try {
        const cfg = req.body;
        let allItems = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            // with_inventory_details=true → includes stock_on_hand
            const { ok, data } = await zohoFetch(
                cfg,
                `items?per_page=200&page=${page}&with_inventory_details=true`
            );

            if (!ok) {
                return res.status(400).json({ message: data.message || 'Failed to fetch items' });
            }

            allItems = allItems.concat(data.items || []);
            hasMore = data.page_context && data.page_context.has_more_page;
            page++;
        }

        const items = allItems
            .filter(i => i.track_inventory !== false)   // skip services/non-stock items
            .map(i => ({
                item_id: i.item_id,
                name: i.name,
                sku: i.sku || '',
                barcode: i.sku || '',        // SKU only — empty string if missing
                price: parseFloat(i.rate) || 0,
                purchase_price: parseFloat(i.purchase_rate) || 0,
                stock: i.stock_on_hand != null ? i.stock_on_hand : 0
            }));

        res.json(items);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
});

   /* ============ POST /api/zoho/adjustment — deduct stock ============ */
   app.post('/api/zoho/adjustment', async (req, res) => {
       try {
           const { cfg, reason, line_items } = req.body;
   
           if (!line_items || !line_items.length) {
               return res.status(400).json({ message: 'No line items provided' });
           }
   
           const { ok, data } = await zohoFetch(cfg, 'inventoryadjustments', {
               method: 'POST',
               body: JSON.stringify({
                   date: new Date().toISOString().split('T')[0],
                   reason: reason || 'POS Sale',
                   line_items: line_items.map(li => ({
                       item_id: li.item_id,
                       name: li.name,
                       quantity_adjusted: li.quantity_adjusted // negative = decrease
                   }))
               })
           });
   
           if (!ok) {
               return res.status(400).json({
                   message: data.message || 'Adjustment failed',
                   details: data
               });
           }
   
           res.json(data);
       } catch (e) {
           res.status(400).json({ message: e.message });
       }
   });
 
   
   /* ============ START ============ */
   app.listen(PORT, () => {
       console.log(`✅ Zoho POS proxy running at http://localhost:${PORT}`);
       console.log('   Endpoints:');
       console.log('   POST /api/zoho/test        — validate credentials');
       console.log('   POST /api/zoho/items       — load inventory (body: cfg)');
       console.log('   POST /api/zoho/adjustment  — deduct stock (body: cfg + payload)');
   });