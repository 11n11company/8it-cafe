# Cafe Cloud POS

A modern, cloud-hosted Point of Sale (POS) system engineered for multi-brand hospitality counters operating under a single legal entity.

---

## 1. Project Overview

**Cafe Cloud POS** is built specifically to address the operational and accounting workflow of a shared counter operating two distinct brands:
1. **Cafe Company** (beverages, savory food, cafe items)
2. **Brownie Shop** (desserts, baked confectioneries, brownies)

### Key Business Realities
- **Single Legal Entity & Shared GST**: Both brands belong to the same parent company and file taxes under one common GST identification number (GSTIN).
- **Single Billing Counter & Tablet**: Counter operations run on one 10-inch Android tablet.
- **Combined Customer Bill**: A customer can purchase items from both brands in a single transaction and receive one unified invoice.
- **Dual Reporting**: Business owners can review both **brand-wise** performance and **consolidated** sales/tax reports.
- **Cloud-Hosted & Online-Only**: Centralized cloud backend providing real-time data integrity.
- **Manual KOT Workflow**: Kitchen Order Tickets (KOT) are generated strictly on-demand by the cashier, never automatically.
- **Dedicated Kitchen Thermal Printer**: A local Wi-Fi thermal printer prints KOT tickets via a local Node.js print daemon.
- **No Kitchen Display System**: There are no kitchen screens or kitchen preparation status dashboards.

---

## 2. Technology Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend** | React 18+, Vite, PWA | High-speed, responsive POS interface optimized for a 10-inch Android tablet (landscape) |
| **Backend** | Node.js, Express | Modular Monolith REST API handling auth, billing, taxes, KOT queuing, and reports |
| **Database** | PostgreSQL | Relational database with ACID transactions, relational integrity, and migration management |
| **Print Agent** | Node.js (Local Daemon) | Lightweight local service running on the local Wi-Fi network to bridge cloud print jobs to the ESC/POS printer |
| **Infrastructure** | Docker & Docker Compose | Containerized backend and database for reproducible local and cloud deployment |
| **VCS** | Git | Distributed version control with clean branching and release strategies |

---

## 3. High-Level Architecture

The system consists of three independently deployable components communicating over secure protocols:

```
+-------------------------------------------------------------------------+
|                              CLOUD LAYER                                |
|                                                                         |
|   +--------------------------+          +---------------------------+   |
|   |   Node.js + Express      |  <====>  |        PostgreSQL         |   |
|   |   (Modular Monolith API) |          |  (Relational DB & Queue)  |   |
|   +--------------------------+          +---------------------------+   |
|              ^                                        ^                 |
+--------------|----------------------------------------|-----------------+
               | HTTPS (JWT Auth)                       | HTTPS (Agent Token)
               v                                        v
+-------------------------------+       +---------------------------------+
|       ON-PREMISE (TABLET)     |       |    ON-PREMISE (LOCAL NETWORK)   |
|                               |       |                                 |
|  10" Android Tablet (PWA)     |       |  Local Node.js Print Agent      |
|  - Cashier POS Interface      |       |  - Polls cloud print queue      |
|  - Combined Cart & Checkout   |       |  - Connects to Wi-Fi Printer    |
|  - Manual "Print KOT" Action  |       +---------------------------------+
+-------------------------------+                       |
                                                        | TCP Socket (ESC/POS)
                                                        v
                                        +---------------------------------+
                                        |    Kitchen Wi-Fi Thermal Printer|
                                        +---------------------------------+
```

---

## 4. Critical Business & Architectural Rules

### 1. Manual KOT Generation Rule
1. Cashier adds items to cart and taps checkout.
2. Invoice and payment (Cash/UPI/Card) are validated and saved in the cloud database.
3. **No KOT is generated automatically.**
4. The cashier manually reviews the completed order and clicks **"Print KOT"**.
5. Only upon this explicit user action is a KOT record created and added to the print queue.
6. The local print agent picks up the job and outputs it to the kitchen Wi-Fi thermal printer.
7. **Print Resilience**: Print failure (paper out, network blip) **never** cancels or voids the customer invoice.

### 2. Server-Authoritative Calculations
- The tablet client sends only line items and quantities (`product_id`, `quantity`).
- The backend calculates item base prices, discounts, and GST (CGST + SGST or IGST) using high-precision math.
- The client UI is purely a display presentation; client values are never trusted for financial transactions.

### 3. Multi-Company Isolation Readiness
- Every core entity (`brands`, `products`, `invoices`, `users`, `print_jobs`) includes a `company_id` foreign key.
- While only one company is active initially, the database schema and query layers are prepared for multi-tenant isolation without schema rewrites.

### 4. No Kitchen Status Dashboards
- The kitchen operation relies solely on physical paper tickets produced by the Wi-Fi thermal printer.
- There is no requirement for kitchen screens, order preparation timers, or order status progression.

---

## 5. Repository Directory Structure

```
cafe-cloud-pos/
├── .gitignore               # Git ignore specifications
├── README.md                # Project master documentation (this file)
├── backend/                 # Node.js + Express Modular Monolith API
├── frontend/                # React + Vite + PWA Tablet Application
├── print-agent/             # Local Node.js Wi-Fi Thermal Print Daemon
├── database/                # Database migrations, seed data, and schema scripts
├── deployment/              # Dockerfiles, docker-compose, and deployment manifests
├── docs/                    # Architectural and functional specifications
│   ├── requirements.md      # Detailed functional & non-functional requirements
│   ├── architecture.md      # Modular monolith design & data flow
│   ├── database-design.md   # Schema specifications & entity relations
│   ├── api-specification.md # REST API contracts and payloads
│   ├── ui-design.md         # 10-inch Android tablet wireframes & UX flows
│   ├── printing-workflow.md # Cloud-to-agent-to-printer pipeline & resilience
│   ├── security-plan.md     # RBAC, token management, and audit logging
│   └── testing-plan.md      # Test pyramid, unit/integration, and hardware simulation
└── tests/                   # End-to-end and cross-component integration test suites
```

---

## 6. Project Phase Roadmap

- [x] **Phase 1: Project Foundation & Technical Specifications** (Current Phase)
  - Define folder structure, architectural blueprints, requirements, and compliance standards.
- [ ] **Phase 2: Database Schema & Migration Foundation**
  - PostgreSQL schema, indexing, foreign keys, and seed data for Cafe Company and Brownie Shop.
- [ ] **Phase 3: Backend Modular Monolith Implementation**
  - Authentication, catalog management, tax engine, billing transaction pipeline, and print queue.
- [ ] **Phase 4: Local Node.js Wi-Fi Print Agent**
  - Queue poller, ESC/POS socket connection, retry management, and printer status heartbeat.
- [ ] **Phase 5: Frontend Tablet PWA**
  - 10-inch landscape POS interface, combined cart, fast payment capture, and manual KOT trigger button.
- [ ] **Phase 6: Integration, Containerization & End-to-End Testing**
  - Full system integration in Docker, mock printer hardware test suite, and operational verification.

---

## 7. Documentation Index

For deep dives into each subsystem, consult the specification files in the `docs/` folder:
- [Requirements Specification](docs/requirements.md)
- [System Architecture](docs/architecture.md)
- [Database Design](docs/database-design.md)
- [API Specification](docs/api-specification.md)
- [Tablet UI & UX Design](docs/ui-design.md)
- [Printing & KOT Workflow](docs/printing-workflow.md)
- [Security & Access Control](docs/security-plan.md)
- [Testing & Quality Assurance](docs/testing-plan.md)

