# ProjectZed

ProjectZed is an online clothing store with a **3D fitting room**. Shoppers can see
every garment worn on a 3D avatar, combine pieces into an outfit, and even try clothes
on a photo of themselves before buying. Store staff add a product by uploading a couple
of flat-lay photos; the 3D version of the garment is generated automatically.

Behind the storefront is a complete shop: accounts, cart, checkout with Stripe and
PayPal, delivery through the Bulgarian couriers Econt and Speedy, order tracking,
discounts, stock control, made-to-order production and an admin dashboard.

## What it does

### For shoppers

- **Browse the catalogue** by product type (T-shirts, long sleeves, hoodies, shorts,
  pants, dresses) and category (polo, V-neck, denim, maxi, ...).
- **3D fitting room.** Every product can be viewed on a male or female 3D avatar that
  you can rotate. The garment is painted from the real product photos, so the print,
  colour and fabric match the item being sold.
- **Build an outfit.** A T-shirt and a pair of jeans can be worn together on the same
  avatar. Putting on a dress takes off the top and the bottoms; a second T-shirt
  replaces the first. The whole outfit can be added to the cart in one click.
- **Try it on your own photo.** Upload a photo of yourself and the selected product (or
  the whole outfit) is drawn onto it. Your face, hair, hands and background stay
  exactly as they were; only the clothing area is regenerated.
- **Size guide** based on body measurements, so the fit shown is the fit promised.
- **Checkout** with card (Stripe) or PayPal, home or office delivery via Econt or
  Speedy, and order tracking afterwards.
- **Personal offers**: a shopper who keeps looking at one kind of product (with cookie
  consent) gets a discount code for it.

### For the store admin

- **Add products** one at a time or **up to 30 in a batch**. Each product needs a
  front photo (and optionally a back photo) of the garment laid flat.
- **Automatic category detection.** An image model looks at the front photo and
  suggests what the garment is (polo, hoodie, jeans, ...), which decides the 3D shape it
  is baked onto. A manual choice always wins.
- **Scheduled 3D generation.** A batch can be started now or at a chosen time (for
  example overnight). Products stay hidden and each one goes live on its own as soon as
  its 3D garment is ready. A failed bake leaves the product hidden with the reason shown.
- **Orders** with a full status history, manual overrides and refunds.
- **Inventory** with low-stock alerts, and a **production queue** for made-to-order
  items (no courier label is requested until the garment has actually been made).
- **Analytics** (views and clicks per product), an **email log**, and a dashboard for
  the background job queues.

## How it works

```
 ┌──────────────┐     ┌──────────────────┐     ┌────────────────────────┐
 │  Web (Next)  │────▶│   API (NestJS)   │────▶│  garment3d-service     │
 │  storefront  │     │  + worker        │     │  (Python, FastAPI)     │
 │  + admin     │     │                  │     │  bake / classify /     │
 └──────────────┘     └──────────────────┘     │  try-on                │
                        │     │      │         └────────────────────────┘
                 PostgreSQL  Redis  S3 storage (MinIO locally)
                            (BullMQ)
```

- **`apps/web`** is the website: the storefront, the 3D viewer (three.js) and the admin
  dashboard.
- **`apps/api`** is the backend. It runs as two processes from the same code: the HTTP
  API, and a **worker** that does all slow or important work from a job queue
  (payments, shipping, emails, 3D bakes).
- **`apps/garment3d-service`** is a Python service that does the image and 3D work.
- **PostgreSQL** stores the data, **Redis** holds the job queues, and **S3-compatible
  storage** holds photos, textures and 3D models.

### From product photos to a 3D garment

The project ships a **library of 3D garment meshes**, one per product type and
category, each already fitted to both avatars. Instead of guessing a new 3D shape from
photos (which looks lumpy), only the *surface* of a known, well-made shape is painted
from the photos:

1. **Cut out** the garment from the photo background (and remove hangers, care labels
   seen through the neck, drawstrings lying across the chest, and so on).
2. **Even out the lighting**, so shadows and studio light from the photo aren't baked
   into the fabric.
3. **Match the photo to the mesh part by part**: the body from shoulders to hem, each
   sleeve along its own length, each trouser leg to the same leg.
4. **Paint** the front and back photos into the garment's texture, fill in what the
   photos never saw, and add fabric detail (knit, seams, ribbing).
5. **Upload** the texture. The viewer puts it on the matching library mesh, which
   already drapes and moves correctly on the avatar.

A bake takes a few minutes on a normal CPU. Bakes run one at a time from the queue, so
a large batch never overloads the machine.

### Photo try-on

The try-on uses [CatVTON](https://github.com/Zheng-Chong/CatVTON), a diffusion model
that receives the person photo and the garment photo separately. A body-parsing model
first works out which parts of the photo the new garment may cover (trousers reach the
ankles, shorts the knees, a T-shirt just past the shoulder), and only that area is
regenerated and pasted back into the original photo. An outfit is applied one garment
at a time: dress, then bottoms, then tops.

### Orders, payments and shipping

A few rules the backend enforces in code:

- **Webhooks never do real work inline.** A payment or courier webhook only checks the
  signature, records the raw event and queues a job. The worker does the rest.
- **Payment and shipping providers sit behind one interface each.** Adding a third
  payment method or courier is one new class.
- **Order status is an append-only history.** Every change is recorded with who or
  what caused it, and illegal changes (for example "delivered" back to "paid") are
  rejected.
- **Stock is reserved before payment and committed after.** Two people buying the last
  item at the same moment can't both succeed.
- **Made-to-order items** create a production ticket; the courier label is only
  requested once every ticket on the order is done.

## What's in the repository

```
apps/
  api/                 NestJS API and background worker
    prisma/            Database schema, migrations, seed and import scripts
    src/               Modules: auth, cart, orders, payments, shipping, inventory,
                       fulfillment, discounts, analytics, notifications, admin,
                       garment-generation, storage, queue
  web/                 Next.js website (storefront, fitting room, admin)
  garment3d-service/   Python service: photo-to-texture bake, category
                       detection, photo try-on
    garments/          The 3D garment library (male and female fits)
packages/
  contracts/           Shared types, validation schemas and business rules
                       (sizes, money, which garments can be worn together)
infra/
  docker-compose.yml   PostgreSQL, Redis, MinIO, Mailpit and the garment3d service
```

More detail on the 3D and try-on pipeline is in
[`apps/garment3d-service/README.md`](apps/garment3d-service/README.md).

## Tech stack

- **Frontend:** Next.js 14 (App Router), React, three.js / React Three Fiber,
  TanStack Query, Zustand, Tailwind CSS
- **Backend:** Node.js 20, NestJS, Prisma, PostgreSQL, BullMQ + Redis, Zod
- **3D and images:** Python, FastAPI, trimesh, NumPy/SciPy, OpenCV, rembg,
  ONNX Runtime, PyTorch + diffusers (try-on)
- **Integrations:** Stripe, PayPal, Econt, Speedy, S3-compatible storage
  (MinIO locally, AWS S3 or Cloudflare R2 in production), SMTP email
- **Tooling:** TypeScript, npm workspaces, Docker Compose, Jest, ESLint

## Getting started

You need **Node.js 20+** and **Docker**. The garment3d container is limited to 8 GB of
memory and downloads several GB of models the first time it starts.

```bash
npm install
cp .env.example .env                   # then fill in your own values
npm run infra:up                       # PostgreSQL, Redis, MinIO, Mailpit, garment3d
npm run db:migrate -w @zed/api         # create the database tables
npm run db:seed -w @zed/api            # demo accounts and products
npm run dev                            # web + API + worker, all at once
```

| Service                    | Address                                  |
| -------------------------- | ---------------------------------------- |
| Storefront                 | http://localhost:3000                    |
| API                        | http://localhost:4000/api                |
| Job queue dashboard        | http://localhost:4000/api/admin/queues   |
| MinIO console (storage)    | http://localhost:9001                    |
| Mailpit (captured emails)  | http://localhost:8025                    |
| garment3d service          | http://127.0.0.1:8100/health             |

The seed script creates a demo admin (`admin@projectzed.bg`) and a demo customer
(`customer@example.com`), both with the password `ChangeMe123!`. These are for local
development only: never run the seed against a public deployment without changing them.

### A realistic catalogue (optional)

```bash
npm run db:import:catalog -w @zed/api            # 2,000 products
npm run db:import:catalog -w @zed/api -- --all   # all ~12,700 matching products
```

This imports real product names, brands, colours and photos from the public
[Myntra fashion dataset](https://huggingface.co/datasets/benitomartin/fashion-product-images-small-900x1200).
The dataset has no prices, so prices are sampled from real price ranges for each
category. The import can be re-run safely.

## Useful commands

```bash
npm run dev          # run everything in development mode
npm run build        # build contracts, API and web
npm run test         # API unit tests
npm run lint         # lint API and web
npm run infra:down   # stop the Docker services
```

## Configuration

All settings live in environment variables; `.env.example` lists every one with a
safe placeholder. Payments and shipping need your own **sandbox** credentials from
Stripe, PayPal, Econt and Speedy; everything else (catalogue, cart, fitting room,
admin) works without them.

Your real `.env` files are ignored by git and must never be committed.

## Third-party models and assets

- **Garment meshes** are adapted from MakeHuman community assets; the CC-BY ones are
  credited in [`apps/garment3d-service/garments/CREDITS.md`](apps/garment3d-service/garments/CREDITS.md).
- **Avatars** are Ready Player Me avatars.
- **Category detection** uses Marqo-FashionSigLIP (Apache-2.0).
- **Photo try-on** uses CatVTON, whose weights are licensed **CC BY-NC-SA 4.0
  (non-commercial)**, and a body-parsing model trained on research-only data. Both
  need a commercial licence or a replacement before the try-on is used in a paid
  product.
