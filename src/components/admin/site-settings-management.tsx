"use client";

import { useState, useEffect, useMemo } from "react";
import { useUser, useFirestore } from "@/firebase";
import { doc, getDoc, serverTimestamp, collection, getDocs } from 'firebase/firestore';
;
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { SiteWideSettings, DEFAULT_SITE_SETTINGS } from "@/types/site-settings";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getStatusLineA } from "@/lib/legal-status";
import { setDoc, updateDoc } from '@/lib/client/firestore-wrapper';


interface SiteSettingsManagementProps {
  className?: string;
}

export default function SiteSettingsManagement({ className }: SiteSettingsManagementProps) {
  const { user } = useUser();
  const firestore = useFirestore();
  const [settings, setSettings] = useState<SiteWideSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [studentsCount, setStudentsCount] = useState(0);

  // Dynamically count students from users collection
  const loadStudentsCount = useMemo(() => {
    return async () => {
      if (!firestore) return;

      try {
        const usersCollection = collection(firestore, 'users');
        const usersSnapshot = await getDocs(usersCollection);
        setStudentsCount(usersSnapshot.size);
      } catch (error) {
        console.error('Error fetching users count:', error);
        setStudentsCount(0);
      }
    };
  }, [firestore]);

  // Load current site settings
  useEffect(() => {
    const loadSettings = async () => {
      if (!firestore) return;

      try {
        setLoading(true);
        // CRITICAL FIX: Use proper document reference structure
        const settingsRef = doc(firestore, 'settings', 'siteWide');
        const docSnap = await getDoc(settingsRef);

        if (docSnap.exists()) {
          setSettings({ id: docSnap.id, ...docSnap.data() } as SiteWideSettings);
        } else {
          // Create default settings if none exist
          const defaultSettings = {
            studentsEngaged: studentsCount, // Use dynamic count
            activeProjects: DEFAULT_SITE_SETTINGS.activeProjects,
            partners: DEFAULT_SITE_SETTINGS.partners,
            globalChapters: DEFAULT_SITE_SETTINGS.globalChapters,
            contactFormDestinationEmail: DEFAULT_SITE_SETTINGS.contactFormDestinationEmail,
            enableDonations: DEFAULT_SITE_SETTINGS.enableDonations,
            enableChapterRegistration: DEFAULT_SITE_SETTINGS.enableChapterRegistration,
            registrationStatus: DEFAULT_SITE_SETTINGS.registrationStatus,
            registrationNumber: DEFAULT_SITE_SETTINGS.registrationNumber,
            registrationDate: DEFAULT_SITE_SETTINGS.registrationDate,
            registrarJurisdiction: DEFAULT_SITE_SETTINGS.registrarJurisdiction,
            updatedAt: serverTimestamp(),
            updatedBy: user?.uid || 'system'
          };
          await setDoc(settingsRef, defaultSettings);
          setSettings({ id: 'siteWide', ...defaultSettings } as SiteWideSettings);
        }
      } catch (error) {
        console.error('Error loading site settings:', error);
        toast({
          title: "Error",
          description: "Failed to load site settings. Please try again.",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
    // Load students count on component mount
    loadStudentsCount();
  }, [firestore, user?.uid, loadStudentsCount]);

  const handleInputChange = (field: keyof SiteWideSettings, value: string | number | boolean) => {
    if (!settings) return;

    const newSettings = { ...settings, [field]: value };
    setSettings(newSettings);
    setHasChanges(true);
  };

  const handleSave = async () => {
    if (!settings || !user) return;

    try {
      setSaving(true);
      // CRITICAL FIX: Use proper document reference structure
      const settingsRef = doc(firestore, 'settings', 'siteWide');

      await updateDoc(settingsRef, {
        studentsEngaged: studentsCount, // Use dynamic count from users collection
        activeProjects: settings.activeProjects || 0,
        partners: settings.partners || 0,
        globalChapters: settings.globalChapters || 25,
        contactFormDestinationEmail: settings.contactFormDestinationEmail || '',
        bugReportEmail: settings.bugReportEmail || '',
        enableDonations: settings.enableDonations || false,
        enableChapterRegistration: settings.enableChapterRegistration || false,
        registrationStatus: settings.registrationStatus || 'in_process',
        registrationNumber: settings.registrationNumber || '',
        registrationDate: settings.registrationDate || '',
        registrarJurisdiction: settings.registrarJurisdiction || '',
        // Platform switches (Workstream H): BOTH fields must stay in
        // this whitelist or the toggles below silently never persist
        // (the updateDoc payload is the only write path).
        siteEnabled: settings.siteEnabled !== false,
        maintenanceMode: settings.maintenanceMode === true,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      });

      setHasChanges(false);
      toast({
        title: "Settings Updated",
        description: "Site-wide settings have been successfully updated.",
      });
    } catch (error) {
      console.error('Error saving site settings:', error);
      toast({
        title: "Error",
        description: "Failed to save site settings. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Loading...</CardTitle>
            <CardDescription>Please wait while we load the site settings.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Error Loading Settings</CardTitle>
            <CardDescription>Unable to load site settings. Please refresh the page.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            🏠 Site-Wide Settings
          </CardTitle>
          <CardDescription>
            Manage global site statistics that appear on the homepage Trust Bar. These numbers communicate our credibility and impact to visitors.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Students Engaged */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="studentsEngaged">Students Engaged</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="studentsEngaged"
                  type="number"
                  min="0"
                  value={studentsCount}
                  disabled
                  className="bg-muted"
                  placeholder="0"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={loadStudentsCount}
                  disabled={loading}
                >
                  Refresh Count
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Dynamically fetched from registered users collection. This represents total registered members.
              </p>
            </div>

            {/* Active Projects */}
            <div className="space-y-2">
              <Label htmlFor="activeProjects">Active Projects</Label>
              <Input
                id="activeProjects"
                type="number"
                min="0"
                value={settings.activeProjects || 0}
                onChange={(e) => handleInputChange('activeProjects', parseInt(e.target.value) || 0)}
                placeholder="0"
              />
              <p className="text-sm text-muted-foreground">
                Number of currently active projects across all teams
              </p>
            </div>

            {/* Partners */}
            <div className="space-y-2">
              <Label htmlFor="partners">Partners</Label>
              <Input
                id="partners"
                type="number"
                min="0"
                value={settings.partners || 0}
                onChange={(e) => handleInputChange('partners', parseInt(e.target.value) || 0)}
                placeholder="0"
              />
              <p className="text-sm text-muted-foreground">
                Strategic partners and sponsors supporting our mission
              </p>
            </div>

            {/* Global Chapters */}
            <div className="space-y-2">
              <Label htmlFor="globalChapters">Global Chapters</Label>
              <Input
                id="globalChapters"
                type="number"
                min="0"
                value={settings.globalChapters || 25}
                onChange={(e) => handleInputChange('globalChapters', parseInt(e.target.value) || 25)}
                placeholder="25"
              />
              <p className="text-sm text-muted-foreground">
                Total SEDS chapters worldwide (update annually)
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="contactFormDestinationEmail">Contact Form Destination Email</Label>
              <Input
                id="contactFormDestinationEmail"
                type="email"
                value={settings.contactFormDestinationEmail || ''}
                onChange={(e) => handleInputChange('contactFormDestinationEmail', e.target.value)}
                placeholder="contact@seds-pakistan.com"
              />
              <p className="text-sm text-muted-foreground">Used by /api/contact for email delivery.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bugReportEmail">Bug Report / Suggestion Email</Label>
              <Input
                id="bugReportEmail"
                type="email"
                value={settings.bugReportEmail || ''}
                onChange={(e) => handleInputChange('bugReportEmail', e.target.value)}
                placeholder="bugs@seds-pakistan.com"
              />
              <p className="text-sm text-muted-foreground">
                Admin users can submit bug reports and suggestions via the floating button on every page. Reports get emailed here.
              </p>
            </div>
          </div>

          <div className="pt-6 border-t space-y-4">
            <h3 className="text-lg font-medium">Legal Registration</h3>
            <p className="text-sm text-muted-foreground">
              Single source of truth for the public registration status line shown in the footer and on the legal pages.
            </p>
            <div className="space-y-2">
              <Label htmlFor="registrationStatus">Registration Status</Label>
              <Select
                value={settings.registrationStatus || 'in_process'}
                onValueChange={(value) => handleInputChange('registrationStatus', value)}
              >
                <SelectTrigger id="registrationStatus">
                  <SelectValue placeholder="Registration in process" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in_process">Registration in process</SelectItem>
                  <SelectItem value="registered">Registered</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {settings.registrationStatus === 'registered' && (
              <>
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
                  Warning: saving publishes a public legal claim. The registration certificate details below must be complete; if any field is blank, the public status line falls back to registration in process.
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="registrationNumber">Registration Number</Label>
                    <Input
                      id="registrationNumber"
                      type="text"
                      value={settings.registrationNumber || ''}
                      onChange={(e) => handleInputChange('registrationNumber', e.target.value)}
                      placeholder="Certificate number"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="registrationDate">Registration Date</Label>
                    <Input
                      id="registrationDate"
                      type="date"
                      value={settings.registrationDate || ''}
                      onChange={(e) => handleInputChange('registrationDate', e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="registrarJurisdiction">Registrar Jurisdiction</Label>
                    <Input
                      id="registrarJurisdiction"
                      type="text"
                      value={settings.registrarJurisdiction || ''}
                      onChange={(e) => handleInputChange('registrarJurisdiction', e.target.value)}
                      placeholder="e.g. Islamabad Capital Territory"
                    />
                  </div>
                </div>
              </>
            )}
            <div className="space-y-2">
              <Label>Public Status Line (preview)</Label>
              <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
                {getStatusLineA(settings)}
              </div>
            </div>
          </div>

          <div className="pt-6 border-t space-y-4">
            <h3 className="text-lg font-medium">Feature Control</h3>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="enableDonations">Enable Donations</Label>
                <p className="text-sm text-muted-foreground">Show donation links and buttons across the site.</p>
              </div>
              <Switch
                id="enableDonations"
                checked={settings.enableDonations || false}
                onCheckedChange={(checked) => handleInputChange('enableDonations', checked)}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="enableChapterRegistration">Enable Chapter Registration</Label>
                <p className="text-sm text-muted-foreground">Allow new chapters to register via the public form.</p>
              </div>
              <Switch
                id="enableChapterRegistration"
                checked={settings.enableChapterRegistration || false}
                onCheckedChange={(checked) => handleInputChange('enableChapterRegistration', checked)}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="siteEnabled">Site Enabled</Label>
                <p className="text-sm text-muted-foreground">Turn the public site off entirely. Admin and sign-in stay reachable. Default on.</p>
              </div>
              <Switch
                id="siteEnabled"
                checked={settings.siteEnabled !== false}
                onCheckedChange={(checked) => handleInputChange('siteEnabled', checked)}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="maintenanceMode">Maintenance Mode</Label>
                <p className="text-sm text-muted-foreground">Show the paused page to visitors while you work. Admin and sign-in stay reachable. Default off.</p>
              </div>
              <Switch
                id="maintenanceMode"
                checked={settings.maintenanceMode === true}
                onCheckedChange={(checked) => handleInputChange('maintenanceMode', checked)}
              />
            </div>
          </div>

          {/* Last Updated Info */}
          {settings.updatedAt && (
            <div className="pt-4 border-t">
              <p className="text-sm text-muted-foreground">
                Last updated: {settings.updatedAt.toDate ? settings.updatedAt.toDate().toLocaleString() : 'Unknown'}
                {settings.updatedBy && ` by ${settings.updatedBy}`}
              </p>
            </div>
          )}

          {/* Save Button */}
          <div className="flex justify-end pt-4">
            <Button
              onClick={handleSave}
              disabled={(!hasChanges && settings.studentsEngaged === studentsCount) || saving}
              className="min-w-[120px]"
            >
              {saving ? 'Saving...' : (hasChanges || settings.studentsEngaged !== studentsCount) ? 'Save Changes' : 'Saved'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
