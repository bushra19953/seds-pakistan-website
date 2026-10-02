"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { firestore as db } from "@/firebase/index";
import { collection, getDocs, writeBatch, doc } from "firebase/firestore";
import { useUser } from "@/firebase/index";
import { hasSufficientRole, ROLES, UserRole } from "@/lib/roles";
import AuthorizationGate from "@/components/admin/AuthorizationGate";

const AdminBackupRestorePage = () => {
  const { user, role } = useUser();
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  const handleExport = async () => {
    setExporting(true);
    try {
      const collectionsToExport = ["users", "blogs", "events", "forms", "auditLogs"]; // Customize as needed
      const exportedData: { [key: string]: any[] } = {};

      for (const colName of collectionsToExport) {
        const querySnapshot = await getDocs(collection(db, colName));
        exportedData[colName] = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      }

      const jsonString = JSON.stringify(exportedData, null, 2);
      const blob = new Blob([jsonString], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      
      if (typeof document !== 'undefined') {
        const a = document.createElement("a");
        a.href = url;
        a.download = `firestore_backup_${new Date().toISOString()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
      
      URL.revokeObjectURL(url);

      toast({ title: "Export Successful", description: "Firestore data exported to JSON." });
    } catch (error: any) {
      toast({ title: "Error", description: `Failed to export data: ${error.message}` });
      console.error("Export error:", error);
    } finally {
      setExporting(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      setFile(event.target.files[0]);
    }
  };

  const handleRestore = async () => {
    if (!file) {
      toast({ title: "Error", description: "Please select a JSON file to restore." });
      return;
    }

    setRestoring(true);
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const jsonString = e.target?.result as string;
          const importedData = JSON.parse(jsonString);

          const batch = writeBatch(db);
          for (const collectionName in importedData) {
            if (Object.prototype.hasOwnProperty.call(importedData, collectionName)) {
              const items = importedData[collectionName];
              for (const item of items) {
                const { id, ...data } = item;
                const docRef = doc(db, collectionName, id);
                batch.set(docRef, data, { merge: true }); // Use merge to avoid overwriting entire documents
              }
            }
          }
          await batch.commit();
          toast({ title: "Restore Successful", description: "Firestore data restored from JSON." });
          setFile(null);
        } catch (parseError: any) {
          toast({ title: "Error", description: `Failed to parse JSON file: ${parseError.message}` });
          console.error("JSON parse error:", parseError);
        }
      };
      reader.readAsText(file);
    } catch (error: any) {
      toast({ title: "Error", description: `Failed to initiate restore: ${error.message}` });
      console.error("Restore initiation error:", error);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <AuthorizationGate permission="canManagePermissions">
    <div className="container mx-auto py-8">
      <Card>
        <CardHeader>
          <CardTitle>Backup and Restore</CardTitle>
          <CardDescription>Export Firestore data to JSON or restore from a JSON file.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-6">
            <h3 className="text-lg font-semibold mb-2">Export Data</h3>
            <p className="text-sm text-gray-600 mb-4">Export selected Firestore collections to a JSON file.</p>
            <Button onClick={handleExport} disabled={exporting}>
              {exporting ? "Exporting..." : "Export All Data"}
            </Button>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-2">Restore Data</h3>
            <p className="text-sm text-gray-600 mb-4">Upload a JSON file to restore data to Firestore. Existing documents with matching IDs will be merged.</p>
            <div className="flex items-center space-x-2">
              <Input id="restoreFile" type="file" accept=".json" onChange={handleFileChange} />
              <Button onClick={handleRestore} disabled={restoring || !file}>
                {restoring ? "Restoring..." : "Restore Data"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
    </AuthorizationGate>
  );
};

export default AdminBackupRestorePage;