import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Users, FileText, FlaskConical, CircuitBoard, Wrench, Printer, Scan, Wind, Flame, Orbit } from "lucide-react";

const skills = [
  {
    icon: Users,
    title: "Teamwork",
    description: "Collaborate effectively on complex aerospace projects from conception to completion.",
  },
  {
    icon: FileText,
    title: "Documentation",
    description: "Master technical writing and documentation standards for engineering projects.",
  },
  {
    icon: FlaskConical,
    title: "Research",
    description: "Develop critical research skills to innovate and solve challenges in space exploration.",
  },
  {
    icon: CircuitBoard,
    title: "PCB Design",
    description: "Design and manufacture custom printed circuit boards for spacecraft subsystems.",
  },
  {
    icon: Wrench,
    title: "Soldering",
    description: "Gain hands-on experience with professional soldering for robust electronic assemblies.",
  },
  {
    icon: Printer,
    title: "3D Printing",
    description: "Utilize additive manufacturing for rapid prototyping and custom parts.",
  },
  {
    icon: Scan,
    title: "Laser Cutting",
    description: "Employ precision laser cutting for fabricating structural components.",
  },
  {
    icon: Wind,
    title: "CFD",
    description: "Simulate and analyze fluid dynamics for aerodynamics and propulsion systems.",
  },
  {
    icon: Flame,
    title: "Thermodynamics",
    description: "Understand the principles of heat transfer and energy in aerospace systems.",
  },
  {
    icon: Orbit,
    title: "Orbital Mechanics",
    description: "Master the physics of spaceflight, including trajectories, maneuvers, and calculations.",
  },
];

export default function SkillsSection() {
  return (
    <section id="skills" className="py-20 md:py-32 bg-background/80 backdrop-blur-sm">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-16 bounce-in">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-foreground">Skills & Workshops</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg text-justify">
            We provide hands-on training in the most sought-after skills in the space industry.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-8">
          {skills.map((skill, index) => (
            <div key={skill.title} className="bounce-in" style={{animationDelay: `${index * 100}ms`}}>
              <Card className="h-full bg-card/60 backdrop-blur-sm border-border hover:border-accent transition-shadow duration-300 transform hover:-translate-y-2 group hover:shadow-lg hover:shadow-accent/30">
                <CardHeader>
                  <div className="mb-4">
                    <skill.icon className="h-12 w-12 text-accent transition-transform duration-300 group-hover:scale-110" />
                  </div>
                  <CardTitle className="text-2xl mb-2">{skill.title}</CardTitle>
                  <CardDescription className="font-body text-base leading-relaxed text-justify">
                    {skill.description}
                  </CardDescription>
                </CardHeader>
              </Card>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
