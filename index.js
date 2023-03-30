import '@shopify/shopify-api/adapters/node';
import { shopifyApi, LATEST_API_VERSION, DeliveryMethod, Session } from "@shopify/shopify-api";
import { restResources } from "@shopify/shopify-api/rest/admin/2023-01";
import * as dotenv from 'dotenv'
import express from 'express';
import crypto from "crypto";
import Client from "ftp";
import winston from 'winston';

// Config
dotenv.config();
const PORT = process.env.PORT;
const SHOP = process.env.SHOP;

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.prettyPrint()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: './vitisoft.log' })
  ]
});

const app = express();

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_SECRET_KEY,
  scopes: process.env.SCOPES.split(","),
  hostName: process.env.HOST_NAME,
  apiVersion: LATEST_API_VERSION,
  isCustomStoreApp: true,
  isEmbeddedApp: false,
  restResources
});

const session = shopify.session.customAppSession(SHOP);

// Just welcome route
app.get('/', (req, res) => {
  res.status(200).send('Shopify webhook');
});

// Add webhook
const handleWebhookRequest = async (
  topic,
  shop,
  webhookRequestBody,
  webhookId,
  apiVersion,
) => {
};

await shopify.webhooks.addHandlers({
  ORDERS_CREATE: [
    {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: '/webhooks',
      callback: handleWebhookRequest,
    },
  ],
});

const response = await shopify.webhooks.register({
  session: session
});

if (response['ORDERS_CREATE'][0]) {
  if (!response['ORDERS_CREATE'][0].success) {
    logger.error(
      `Failed to register ORDERS_CREATE webhook: ${response['ORDERS_CREATE'][0].result}`,
    );
  } else {
    logger.info(`Success: ${response['ORDERS_CREATE'][0].success}`);
  }
} else {
  logger.info("Webhook already registered");
}

// Middleware making HMAC verification
function validateShopifySignature() {
  return async (req, res, next) => {
      try {
          const rawBody = req.body;
          if (typeof rawBody == 'undefined') {
              throw new Error(
                  'validateShopifySignature: req.rawBody is undefined. Please make sure the raw request body is available as req.rawBody.'
              )
          }
          const hmac = req.headers['x-shopify-hmac-sha256'];
          const hash = crypto
              .createHmac('sha256', process.env.SHOPIFY_SECRET_API_KEY)
              .update(rawBody)
              .digest('base64');

          const signatureOk = crypto.timingSafeEqual(
              Buffer.from(hash),
              Buffer.from(hmac)
          );

          if (!signatureOk) {
              res.status(401);
              res.send('Unauthorized');
              return;
          }
          next();
      } catch (err) {
          res.status(500);
          res.send('Internal Server Error');
          logger.error(`Validation failed: ${err}`);
          next(err);
      }
  }
}

// Create csv from order json
function createCSVFromJSON(order) {
  let data = "numero_commande;mail_client;date_heure_commande;date_heure_reglement;mode_reglement;reference_commande_client;nom_facturation;prenom_facturation;societe_facturation;adresse1_facturation;adresse2_facturation;code_postal_facturation;ville_facturation;pays_facturation;mobile_facturation;telephone_facturation;nom_livraison;prenom_livraison;societe_livraison;adresse1_livraison;adresse2_livraison;code_postal_livraison;ville_livraison;pays_livraison;telephone_livraison;mobile_livraison;transporteur;commentaire;montant_livraison_ttc;total_ttc;numéro_ligne;numéro_produit;designation;quantite;poids_unitaire;taux_tva;prix_unitaire_ttc;prix_unitaire_sans_remise_ttc;taux_remise_unitaire;montant_remise_unitaire;total_ttc_ligne\r\n";
  let i = 1;

  let transporteur = "";
  if (order.shipping_lines && order.shipping_lines[0]) {
    transporteur = order.shipping_lines[0].title;
  }

  for (const item of order.line_items) {
    let prix_unitaire_ttc = item.price;
    let montant_remise_unitaire = 0;
    let taux_remise_unitaire = 0;

    for (const discount of item.discount_allocations) {
      montant_remise_unitaire += discount.amount;
    }
    
    if (montant_remise_unitaire > 0) {
      montant_remise_unitaire = Math.round((montant_remise_unitaire / item.quantity) * 100) / 100;
      prix_unitaire_ttc -= montant_remise_unitaire;
      taux_remise_unitaire = Math.round((1 - (prix_unitaire_ttc / item.price)) * 100);
    }
    
    const total_ttc_ligne = Math.round(prix_unitaire_ttc * item.quantity * 100) / 100;

    let rate = "";
    if (item.tax_lines && item.tax_lines[0]) {
      rate = Number(item.tax_lines[0].rate) * 100;
    }
    data += `${order.id};${order.customer.email};${order.created_at};${order.created_at};${order.gateway};${order.order_number};${order.billing_address.last_name};${order.billing_address.first_name};${order.billing_address.company};${order.billing_address.address1};${order.billing_address.address2};${order.billing_address.zip};${order.billing_address.city};${order.billing_address.country};${order.billing_address.phone};${order.billing_address.phone};${order.shipping_address.last_name};${order.shipping_address.first_name};${order.shipping_address.company};${order.shipping_address.address1};${order.shipping_address.address2};${order.shipping_address.zip};${order.shipping_address.city};${order.shipping_address.country};${order.shipping_address.phone};${order.shipping_address.phone};${transporteur};${order.note};${order.total_shipping_price_set.shop_money.amount};${order.total_price};${i};${item.vitisoft_id};${item.name};${item.quantity};${item.grams};${rate};${prix_unitaire_ttc};${item.price};${taux_remise_unitaire};${montant_remise_unitaire};${total_ttc_ligne}\r\n`;
    i++;
  }

  data = data.replace(/null/g, "");

  const ftpClient = new Client();
  try {
    ftpClient.on("ready", function() {
      ftpClient.put(`../order-${order.id}.csv`, `order-${order.id}.csv`, function(err) {
        if (err) throw err;
        ftpClient.end();
      });
    });
    
    ftpClient.connect({
      host: process.env.FTP_HOST,
      port: process.env.FTP_PORT,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASSWORD
    });

    logger.info(`Order ${order.id} FTP upload successfull`);
  } catch(err) {
    logger.error(err);
  }
}

// Process webhooks
app.post('/webhooks', express.text({type: '*/*'}), validateShopifySignature(), async (req, res) => {
  // Send ok response to Shopify
  res.status(200);
  res.send('OK');

  const data = JSON.parse(req.body);

  logger.info(`New order received, id: ${data.id}`);

  // Get vitisoft id from metafield
  for (const item of data.line_items) {
    item.vitisoft_id = "";

    const metafields = await shopify.rest.Metafield.all({
      session: session,
      variant_id: item.variant_id
    });

    for (const metafield of metafields) {
      if (metafield.key === "vitisoft_id") {
        item.vitisoft_id = metafield.value;
        break;
      }
    }    
  }

  createCSVFromJSON(data);
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server started and listening at ${process.env.HOST_NAME}:${PORT}`);
});
