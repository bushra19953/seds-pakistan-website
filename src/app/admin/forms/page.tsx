"use client";

import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { firestore as db } from "@/firebase/index";
import { collection, getDocs, doc } from 'firebase/firestore';
;
import { useUser } from "@/firebase/index";
import { useAuthorization } from "@/hooks/use-authorization";
import { toast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { addDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from "@/components/admin/AuthorizationGate";

interface FormField {
  id: string;
  label: string;
  type: string; // e.g., 'text', 'email', 'number', 'textarea'
  required: boolean;
}

interface Form {
  id?: string;
  title: string;
  description: string;
  fields: FormField[];
  createdAt: string;
  updatedAt: string;
}

const AdminFormsPage = () => {
  const { user } = useUser();
  const { isAuthorized: canManageForms, isLoading: authLoading } = useAuthorization('canManageForms');
  const router = useRouter();
  const [forms, setForms] = useState<Form[]>([]);
  const [newForm, setNewForm] = useState<Form>({ title: "", description: "", fields: [], createdAt: "", updatedAt: "" });
  const [editingForm, setEditingForm] = useState<Form | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && canManageForms) {
      fetchForms();
    }
  }, [canManageForms, authLoading]);

  const fetchForms = async () => {
    const formsCollection = collection(db, "forms");
    const formSnapshot = await getDocs(formsCollection);
    const formsList = formSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate().toLocaleString() || "",
      updatedAt: doc.data().updatedAt?.toDate().toLocaleString() || "",
    })) as Form[];
    setForms(formsList);
  };

  const handleCreateForm = async () => {
    if (!newForm.title || !newForm.description) {
      toast({ title: "Error", description: "Title and description are required." });
      return;
    }
    try {
      const now = new Date();
      await addDoc(collection(db, "forms"), {
        ...newForm,
        createdAt: now,
        updatedAt: now,
      });
      toast({ title: "Success", description: "Form created successfully." });
      fetchForms();
      setNewForm({ title: "", description: "", fields: [], createdAt: "", updatedAt: "" });
      setIsDialogOpen(false);
    } catch (error: any) {
      toast({ title: "Error", description: `Failed to create form: ${error.message}` });
      console.error("Error creating form:", error);
    }
  };

  const handleUpdateForm = async () => {
    if (!editingForm?.id || !editingForm.title || !editingForm.description) {
      toast({ title: "Error", description: "Form ID, title, and description are required." });
      return;
    }
    try {
      const formRef = doc(db, "forms", editingForm.id);
      await updateDoc(formRef, {
        title: editingForm.title,
        description: editingForm.description,
        fields: editingForm.fields,
        updatedAt: new Date(),
      });
      toast({ title: "Success", description: "Form updated successfully." });
      fetchForms();
      setEditingForm(null);
      setIsDialogOpen(false);
    } catch (error: any) {
      toast({ title: "Error", description: `Failed to update form: ${error.message}` });
      console.error("Error updating form:", error);
    }
  };

  const handleDeleteForm = async (formId: string) => {
    if (typeof window !== 'undefined' && window.confirm("Are you sure you want to delete this form?")) {
      try {
        await deleteDoc(doc(db, "forms", formId));
        toast({ title: "Success", description: "Form deleted successfully." });
        fetchForms();
      } catch (error: any) {
        toast({ title: "Error", description: `Failed to delete form: ${error.message}` });
        console.error("Error deleting form:", error);
      }
    }
  };

  const handleAddField = () => {
    const newField: FormField = { id: Date.now().toString(), label: "New Field", type: "text", required: false };
    if (editingForm) {
      setEditingForm({ ...editingForm, fields: [...editingForm.fields, newField] });
    } else {
      setNewForm({ ...newForm, fields: [...newForm.fields, newField] });
    }
  };

  const handleFieldChange = (fieldId: string, key: keyof FormField, value: string | boolean) => {
    const updateFields = (fields: FormField[]) =>
      fields.map((field) =>
        field.id === fieldId ? { ...field, [key]: value } : field
      );

    if (editingForm) {
      setEditingForm({ ...editingForm, fields: updateFields(editingForm.fields) });
    } else {
      setNewForm({ ...newForm, fields: updateFields(newForm.fields) });
    }
  };

  const handleRemoveField = (fieldId: string) => {
    const filterFields = (fields: FormField[]) => fields.filter((field) => field.id !== fieldId);
    if (editingForm) {
      setEditingForm({ ...editingForm, fields: filterFields(editingForm.fields) });
    } else {
      setNewForm({ ...newForm, fields: filterFields(newForm.fields) });
    }
  };

  return (
    <AuthorizationGate permission="canManageForms">
    <div className="container mx-auto py-8">
      <Card>
        <CardHeader>
          <CardTitle>Forms Builder</CardTitle>
          <CardDescription>Create and manage dynamic forms.</CardDescription>
        </CardHeader>
        <CardContent>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={() => { setNewForm({ title: "", description: "", fields: [], createdAt: "", updatedAt: "" }); setEditingForm(null); setIsDialogOpen(true); }}>
                Create New Form
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[800px]">
              <DialogHeader>
                <DialogTitle>{editingForm ? "Edit Form" : "Create New Form"}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="title" className="text-right">Title</Label>
                  <Input
                    id="title"
                    value={editingForm ? editingForm.title : newForm.title}
                    onChange={(e) =>
                      editingForm
                        ? setEditingForm({ ...editingForm, title: e.target.value })
                        : setNewForm({ ...newForm, title: e.target.value })
                    }
                    className="col-span-3"
                  />
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="description" className="text-right">Description</Label>
                  <Input
                    id="description"
                    value={editingForm ? editingForm.description : newForm.description}
                    onChange={(e) =>
                      editingForm
                        ? setEditingForm({ ...editingForm, description: e.target.value })
                        : setNewForm({ ...newForm, description: e.target.value })
                    }
                    className="col-span-3"
                  />
                </div>

                <h3 className="text-lg font-semibold mt-4">Form Fields</h3>
                <Button onClick={handleAddField} className="w-fit">Add Field</Button>
                {(editingForm ? editingForm.fields : newForm.fields).map((field) => (
                  <Card key={field.id} className="p-4 mb-2">
                    <div className="grid grid-cols-4 items-center gap-4 mb-2">
                      <Label className="text-right">Label</Label>
                      <Input
                        value={field.label}
                        onChange={(e) => handleFieldChange(field.id, "label", e.target.value)}
                        className="col-span-3"
                      />
                    </div>
                    <div className="grid grid-cols-4 items-center gap-4 mb-2">
                      <Label className="text-right">Type</Label>
                      <select
                        value={field.type}
                        onChange={(e) => handleFieldChange(field.id, "type", e.target.value)}
                        className="col-span-3 border rounded-md p-2"
                      >
                        <option value="text">Text</option>
                        <option value="email">Email</option>
                        <option value="number">Number</option>
                        <option value="textarea">Textarea</option>
                        <option value="checkbox">Checkbox</option>
                        <option value="radio">Radio</option>
                        <option value="select">Select</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-4 items-center gap-4 mb-2">
                      <Label className="text-right">Required</Label>
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={(e) => handleFieldChange(field.id, "required", e.target.checked)}
                        className="col-span-3"
                      />
                    </div>
                    <Button variant="destructive" onClick={() => handleRemoveField(field.id)}>Remove Field</Button>
                  </Card>
                ))}
              </div>
              <DialogFooter>
                <Button
                  type="submit"
                  onClick={editingForm ? handleUpdateForm : handleCreateForm}
                >
                  {editingForm ? "Save Changes" : "Create Form"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <div className="mt-8">
            <h2 className="text-xl font-semibold mb-4">Existing Forms</h2>
            {forms.length === 0 ? (
              <p>No forms created yet.</p>
            ) : (
              <div className="grid gap-4">
                {forms.map((form) => (
                  <Card key={form.id} className="p-4">
                    <CardHeader>
                      <CardTitle>{form.title}</CardTitle>
                      <CardDescription>{form.description}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p>Created: {form.createdAt}</p>
                      <p>Last Updated: {form.updatedAt}</p>
                      <div className="flex space-x-2 mt-4">
                        <Button
                          variant="outline"
                          onClick={() => {
                            setEditingForm(form);
                            setIsDialogOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => router.push(`/admin/forms/responses?formId=${form.id}`)}
                        >
                          View Responses
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={() => form.id && handleDeleteForm(form.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
    </AuthorizationGate>
  );
};

export default AdminFormsPage;