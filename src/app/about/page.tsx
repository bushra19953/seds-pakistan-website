'use client';

import { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import TimelineSection from '@/components/sections/timeline-section';
import RoleHistoryTimelineSection from '@/components/sections/role-history-timeline';
import { firestore } from '@/firebase';
import { doc, getDoc } from 'firebase/firestore';
import createDOMPurify from 'dompurify';

interface PageContent {
  title: string;
  content: string;
  meta_description: string;
}

const AboutPage = () => {
  // Default content used when Firestore doc is missing or empty
  const defaultContent: PageContent = {
    title: 'About Us',
    content: `
      <div class="container mx-auto py-8">
        <h1 class="text-3xl font-bold mb-4">About Us</h1>
        <p class="text-lg">This is the about page of our application.</p>
        <p class="mb-8">More content will be added here soon.</p>

        <section class="mb-8">
          <h2 class="text-2xl font-semibold mb-4">About Astronautics</h2>
          <p class="text-lg mb-4">
            Astronautics is the science and technology of spaceflight. It's a vast field encompassing the design, development, and operation of spacecraft.
          </p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="bg-gray-100 p-6 rounded-lg shadow-md">
              <h3 class="text-xl font-medium mb-2">Infographic Block 1: Key Milestones</h3>
              <p>Placeholder for an infographic detailing key milestones in astronautics, such as Sputnik 1, Vostok 1, Apollo 11, and the ISS.</p>
            </div>
            <div class="bg-gray-100 p-6 rounded-lg shadow-md">
              <h3 class="text-xl font-medium mb-2">Infographic Block 2: Components of a Space Mission</h3>
              <p>Placeholder for an infographic illustrating the various components of a space mission, including launch vehicles, spacecraft, ground control, and mission objectives.</p>
            </div>
          </div>
        </section>
      </div>
    `,
    meta_description: 'Learn more about our organization and mission',
  };

  const [pageContent, setPageContent] = useState<PageContent>(defaultContent);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [hasMounted, setHasMounted] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);
  const mountsRef = useRef<{ container: HTMLElement; root: any }[]>([]);


  // Create URL-friendly ids for headings
  const slugify = (str: string) =>
    str
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

  useEffect(() => {
    setHasMounted(true);
    // Fetch page content on mount only
    const fetchPageContent = async () => {
      try {
        const docRef = doc(firestore, 'pages', 'about');
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
          const data = docSnap.data() as PageContent;
          const normalized = (data.content || '').trim();
          if (!normalized) {
            // Use default content when Firestore content is empty/whitespace
            setPageContent(defaultContent);
          } else {
            setPageContent(data);
          }
        } else {
          // Use default content if no custom content exists
          setPageContent(defaultContent);
        }
        setError('');
      } catch (err) {
        console.error('Error loading page content:', err);
        setError('Failed to load page content. Please try again later.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchPageContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount

  // Build in-page navigation from H2/H3 headings in rendered content
  useEffect(() => {
    if (isLoading || error) return;
    const container = contentRef.current;
    if (!container) return;

    const seenIds = new Set<string>();
    const headings = Array.from(container.querySelectorAll('h2, h3')) as HTMLHeadingElement[];
    const items: { id: string; text: string; level: number }[] = [];

    headings.forEach((el, idx) => {
      const text = (el.textContent || `Section ${idx + 1}`).trim();
      let id = el.id || slugify(text);
      // Ensure uniqueness
      let suffix = 1;
      while (seenIds.has(id)) {
        id = `${id}-${suffix++}`;
      }
      el.id = id;
      seenIds.add(id);
      items.push({ id, text, level: el.tagName === 'H2' ? 2 : 3 });
    });

    setToc(items);
  }, [isLoading, error, pageContent.content]);

  // Detect and mount embed placeholders for dynamic sections (timeline, role history)
  useEffect(() => {
    if (isLoading || error) return;
    const container = contentRef.current;
    if (!container) return;

    // Cleanup any previous mounts to avoid duplicates
    mountsRef.current.forEach((m) => {
      try { m.root.unmount(); } catch { }
    });
    mountsRef.current = [];

    const nodes = container.querySelectorAll('div[data-embed]');
    nodes.forEach((node) => {
      const el = node as HTMLElement;
      const type = el.dataset.embed;
      if (!type) return;
      const root = createRoot(el);
      if (type === 'role-history-timeline') {
        root.render(<RoleHistoryTimelineSection />);
      } else if (type === 'timeline') {
        root.render(<TimelineSection />);
      }
      mountsRef.current.push({ container: el, root });
    });

    return () => {
      mountsRef.current.forEach((m) => {
        try { m.root.unmount(); } catch { }
      });
      mountsRef.current = [];
    };
  }, [isLoading, error, pageContent.content]);

  if (isLoading) {
    return (
      <div className="container mx-auto py-8">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto py-8">
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4">
      {/* SEO Meta Tags */}
      {pageContent.meta_description && (
        <meta name="description" content={pageContent.meta_description} />
      )}

      {/* In-Page Navigation */}
      {toc.length > 0 && (
        <nav aria-label="About page navigation" className="mb-6">
          <div className="flex flex-wrap gap-2">
            {toc.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  const target = document.getElementById(item.id);
                  if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                className={`px-3 py-1 rounded-full text-sm transition-colors hover:bg-muted hover:text-primary ${item.level === 2 ? 'bg-muted text-muted-foreground' : 'bg-muted/60 text-muted-foreground'
                  }`}
                title={item.text}
              >
                {item.text}
              </a>
            ))}
          </div>
        </nav>
      )}

      {/* Main Content */}
      <div
        ref={contentRef}
        dangerouslySetInnerHTML={{
          __html: (() => {
            const raw = String(pageContent.content || '');
            // SSR-safe: skip DOMPurify on server (no window); content is from our own CMS
            if (!hasMounted || typeof window === 'undefined') return raw;
            const purifier = createDOMPurify(window as unknown as any);
            return purifier.sanitize(raw);
          })()
        }}
        className="prose prose-lg max-w-none"
      />

      {/* Leadership Timeline Section — only show if not already embedded via CMS data-embed */}
      {!pageContent.content?.includes('data-embed="role-history-timeline"') && (
        <RoleHistoryTimelineSection />
      )}

      {/* Fallback content if no custom content is set */}
      {!pageContent.content && (
        <div className="mt-8">
          <h1 className="text-3xl font-bold mb-4">{pageContent.title}</h1>
          <p className="text-lg">This page content is managed through the admin panel.</p>
          <p className="text-muted-foreground">Please contact an administrator to update this content.</p>
        </div>
      )}
    </div>
  );
};

export default AboutPage;
