"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/loading-states";
import { firestore as db } from "@/firebase/index";
import { doc, getDoc, collection, getDocs } from "firebase/firestore";
import { useUser } from "@/firebase/index";
import { hasSufficientRole, ROLES, UserRole } from "@/lib/roles";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { toast } from "@/hooks/use-toast";

interface FormField {
  id: string;
  label: string;
  type: string;
  required: boolean;
}

interface Form {
  id?: string;
  title: string;
  description: string;
  fields: FormField[];
}

interface FormResponse {
  id: string;
  formId: string;
  submittedAt: string;
  data: { [key: string]: any };
}

const FormResponsesContent = () => {
  const { user, role } = useUser();
  const searchParams = useSearchParams();
  const formId = searchParams.get('formId');
  const [form, setForm] = useState<Form | null>(null);
  const [responses, setResponses] = useState<FormResponse[]>([]);
  const [loading, setLoading] = useState(true);

  // FIX: Stabilize useEffect dependencies
  // The original dependency array used `canViewResponses`, which derives from `user` and `role` values
  // coming from `useUser()`. During auth/role listener initialization, the `user` and `role` objects can
  // have changing identities across renders even when their logical values don’t change, causing the
  // derived boolean to appear “unstable” and retrigger the effect repeatedly.
  //
  // Solution: Depend only on stable, primitive values. We use `user?.uid` (string), `role` (string|null),
  // and `formId` (string|null). This breaks the infinite loop by preventing the effect from retriggering
  // due to object identity changes.
  useEffect(() => {
    if (user?.uid && role && formId) {
      fetchFormAndResponses();
    }
  }, [user?.uid, role, formId]);

  // End loading if no formId is provided; show an empty state instead of spinning forever
  useEffect(() => {
    if (user?.uid && role && !formId) {
      setLoading(false);
    }
  }, [user?.uid, role, formId]);

  const fetchFormAndResponses = async () => {
    setLoading(true);
    try {
      // Fetch form details
      const formDocRef = doc(db, "forms", formId as string);
      const formDocSnap = await getDoc(formDocRef);

      if (formDocSnap.exists()) {
        setForm({ id: formDocSnap.id, ...formDocSnap.data() } as Form);

        // Fetch responses for this form
        const responsesCollectionRef = collection(db, `forms/${formId}/responses`);
        const responseSnapshot = await getDocs(responsesCollectionRef);
        const responsesList = responseSnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
          submittedAt: doc.data().submittedAt?.toDate().toLocaleString() || "",
        })) as FormResponse[];
        setResponses(responsesList);
      } else {
        toast({ title: "Error", description: "Form not found." });
      }
    } catch (error: any) {
      toast({ title: "Error", description: `Failed to fetch form or responses: ${error.message}` });
      console.error("Error fetching form or responses:", error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <Card>
          <CardHeader>
            <CardTitle>Loading Form Responses</CardTitle>
            <CardDescription>Please wait while we load the form data...</CardDescription>
          </CardHeader>
          <CardContent>
            <TableSkeleton rows={8} columns={6} />
          </CardContent>
        </Card>
      </div>
    );
  }

  // No specific form selected: show guidance
  if (!formId && !loading) {
    return (
      <div className="container mx-auto py-8">
        <Card>
          <CardHeader>
            <CardTitle>Select a form to view responses</CardTitle>
            <CardDescription>Provide a `formId` in the URL query to load responses.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Example: /admin/forms/responses?formId=YOUR_FORM_ID</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!form) {
    return <p>Form not found.</p>;
  }


  return (
    <div className="container mx-auto py-8">
      <Card>
        <CardHeader>
          <CardTitle>Responses for: {form.title}</CardTitle>
          <CardDescription>{form.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {responses.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No responses yet for this form.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Submitted At</TableHead>
                  {form.fields.map((field) => (
                    <TableHead key={field.id}>{field.label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {responses.map((response) => (
                  <TableRow key={response.id}>
                    <TableCell>{response.submittedAt}</TableCell>
                    {form.fields.map((field) => (
                      <TableCell key={field.id}>{response.data[field.id] || "N/A"}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

const FormResponsesPage = () => {
  return (
    <AuthorizationGate permission="canManageForms">
      <Suspense fallback={<div className="container mx-auto py-8"><Card><CardContent><p>Loading...</p></CardContent></Card></div>}>
        <FormResponsesContent />
      </Suspense>
    </AuthorizationGate>
  );
};

export default FormResponsesPage;
