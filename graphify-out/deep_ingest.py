import json
import os
from pathlib import Path

graph_path = Path('graphify-out/graph.json')
if not graph_path.exists():
    print("Graph not found")
    exit(1)

with open(graph_path, 'r') as f:
    graph = json.load(f)

# Deep extraction data
new_nodes = [
  {"label": "Admin Dashboard", "description": "Central management hub providing real-time overview stats, recent activity logs, and quick actions.", "type": "System"},
  {"label": "Store System", "description": "E-commerce module managing products, orders, and certificates with strict numeric validation.", "type": "System"},
  {"label": "Organizations Management", "description": "Handles relationships with National Chapters, Universities, Partners, and Sponsors.", "type": "System"},
  {"label": "Positions Management", "description": "Maintains the institutional memory by recording historical leadership roles and alumni data.", "type": "System"},
  {"label": "Firestore Database", "description": "Primary NoSQL data store for users, products, orders, organizations, and positions.", "type": "Architectural Component"},
  {"label": "Redis Cache", "description": "Proposed high-performance layer for storing pre-calculated dashboard metrics and SSE event streams.", "type": "Architectural Component"},
  {"label": "RBAC System", "description": "Role-Based Access Control enforcing an 11-level hierarchy from Guest to Superadmin.", "type": "Policy"},
  {"label": "MetricCard Abstraction", "description": "Generic UI component used across systems to display standardized statistical data.", "type": "Architectural Component"},
  {"label": "Recent Activity Log", "description": "Real-time feed of system actions (e.g., role assignments) displayed on the dashboard.", "type": "Architectural Component"},
  {"label": "Quick Actions Registry", "description": "Configuration-driven grid that dynamically renders buttons based on user permissions.", "type": "Architectural Component"},
  {"label": "Credibility Marquee", "description": "Homepage component that pulls global organization data for visual brand verification.", "type": "Architectural Component"},
  {"label": "Continuity Automation", "description": "Cloud function logic that automatically archives old position records when new ones are created.", "type": "Policy"},
  {"label": "User Role Definitions", "description": "The source of truth for permission-based job titles and access levels in the system.", "type": "Policy"},
  {"label": "Audit Logging System", "description": "Backend service that captures all administrative actions for security and tracking.", "type": "System"},
  {"label": "Order Lifecycle", "description": "Strict policy governing order creation, payment validation, and status updates.", "type": "Policy"}
]

new_edges = [
  {"source": "Admin Dashboard", "target": "Firestore Database", "label": "interaction", "rationale": "Fetches global stats and activity logs for display."},
  {"source": "Admin Dashboard", "target": "Redis Cache", "label": "interaction", "rationale": "Queries pre-calculated metrics to achieve sub-50ms latency targets."},
  {"source": "Store System", "target": "Firestore Database", "label": "interaction", "rationale": "Persists product catalogs, inventory, and transaction records."},
  {"source": "Store System", "target": "RBAC System", "label": "interaction", "rationale": "Enforces 'canManageStore' permission for administrative access."},
  {"source": "Organizations Management", "target": "Firestore Database", "label": "interaction", "rationale": "Stores records for national chapters and university partners."},
  {"source": "Organizations Management", "target": "Credibility Marquee", "label": "interaction", "rationale": "Provides validated logo and status data for the public-facing homepage."},
  {"source": "Positions Management", "target": "Firestore Database", "label": "interaction", "rationale": "Records historical leadership data and term dates."},
  {"source": "Positions Management", "target": "Continuity Automation", "label": "interaction", "rationale": "Triggers automated updates to ensure only one 'current' holder exists per role."},
  {"source": "Positions Management", "target": "User Role Definitions", "label": "interaction", "rationale": "Maps job titles to existing system role identifiers for consistency."},
  {"source": "RBAC System", "target": "User Role Definitions", "label": "interaction", "rationale": "Uses defined levels (0-11) to manage system-wide access permissions."},
  {"source": "Admin Dashboard", "target": "MetricCard Abstraction", "label": "interaction", "rationale": "Uses the abstraction to render Users, Projects, and Blogs stat cards."},
  {"source": "Admin Dashboard", "target": "Recent Activity Log", "label": "interaction", "rationale": "Displays the real-time feed of system events to administrators."},
  {"source": "Store System", "target": "MetricCard Abstraction", "label": "interaction", "rationale": "Displays sales totals and pending order metrics via standardized cards."},
  {"source": "Audit Logging System", "target": "Recent Activity Log", "label": "interaction", "rationale": "Pushes system events into the dashboard feed via Redis/SSE."},
  {"source": "Order Lifecycle", "target": "Store System", "label": "interaction", "rationale": "Defines valid states and transitions for the store's purchasing flow."},
  {"source": "Quick Actions Registry", "target": "Admin Dashboard", "label": "interaction", "rationale": "Populates the dashboard's action grid based on the user's RBAC permissions."},
  {"source": "Positions Management", "target": "RBAC System", "label": "interaction", "rationale": "Restricts position administrative access to top-tier roles like Superadmin."},
  {"source": "Organizations Management", "target": "RBAC System", "label": "interaction", "rationale": "Enforces 'canManageOrganizations' permission for partner registry updates."},
  {"source": "Firestore Database", "target": "Continuity Automation", "label": "interaction", "rationale": "Triggers Cloud Functions on document creation within the 'positions' collection."},
  {"source": "Recent Activity Log", "target": "Redis Cache", "label": "interaction", "rationale": "Leverages Redis Pub/Sub for efficient Server-Sent Events (SSE) streaming."}
]

# Merge logic
existing_labels = {n['id'] for n in graph['nodes']}
for n in new_nodes:
    if n['label'] not in existing_labels:
        graph['nodes'].append({
            "id": n['label'],
            "label": n['label'],
            "description": n['description'],
            "type": n['type'],
            "source": "Deep Extraction"
        })

for e in new_edges:
    graph['links'].append({
        "source": e['source'],
        "target": e['target'],
        "label": e['label'],
        "rationale": e['rationale'],
        "type": "INFERRED",
        "confidence": 0.9
    })

with open(graph_path, 'w') as f:
    json.dump(graph, f, indent=2)

print(f"Deep pass complete. Added {len(new_nodes)} nodes and {len(new_edges)} edges.")
