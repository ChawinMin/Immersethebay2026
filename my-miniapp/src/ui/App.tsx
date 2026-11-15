import {useState, useEffect, useRef} from "react"
import type {JSX} from "react"
import type {TutorialModel, TutorialStepModel, TranscriptEntry} from "../shared/channels"
import {
  GraduationCapIcon,
  VideoIcon,
  MicIcon,
  Volume2Icon,
  CheckCircleIcon,
  PlayIcon,
  SquareIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  RotateCcwIcon,
  SparklesIcon,
  SendIcon
} from "./Icons"

// Pre-seeded high quality Ceremonial Matcha tutorial
const DEFAULT_MATCHA_TUTORIAL: TutorialModel = {
  id: "tut_matcha_ceremonial_01",
  title: "How to Make Matcha: Traditional Ceremonial Method",
  description: "Master the peaceful art of Japanese matcha preparation. Learn proper chashaku measuring, temperature management, and the brisk W-whisking technique for a thick jade micro-foam.",
  category: "Culinary Arts",
  total_steps: 6,
  estimated_duration_minutes: 5,
  created_at: "2026-11-14T15:00:00Z",
  status: "published",
  tools_required: ["Chawan (Tea Bowl)", "Chasen (100-prong Bamboo Whisk)", "Chashaku (Bamboo Scoop)", "Fine Mesh Sifter"],
  ingredients_required: ["Ceremonial Grade Matcha (2g)", "Filtered Hot Water at 80°C / 175°F (70ml)"],
  steps: [
    {
      id: "step_01",
      step_number: 1,
      title: "Warm the Chawan & Condition Whisk",
      instruction_spoken: "Pour hot water into your tea bowl to warm the ceramic, and briefly rest the tips of your bamboo whisk in the warm water to soften the tines.",
      instruction_detailed: "Pre-warming the chawan prevents rapid cooling during whisking. Conditioning the chasen prevents brittle bamboo tines from snapping.",
      source_timestamp_seconds: 10,
      tips: ["Swirl the water gently, then empty the bowl and wipe it completely dry with a clean cloth before continuing."]
    },
    {
      id: "step_02",
      step_number: 2,
      title: "Sift the Matcha Powder",
      instruction_spoken: "Place your fine-mesh sifter over the dry bowl and use the bamboo chashaku scoop to measure two rounded scoops of matcha powder.",
      instruction_detailed: "Matcha is ultra-fine stone-ground green tea and naturally clumps due to static. Sifting is essential for a smooth, lump-free beverage.",
      source_timestamp_seconds: 28,
      tips: ["Two curved scoops of the chashaku equal approximately 2 grams (1 teaspoon) of matcha."]
    },
    {
      id: "step_03",
      step_number: 3,
      title: "Add 80°C (175°F) Water",
      instruction_spoken: "Pour about 70 milliliters of hot water over the sifted matcha. Ensure the water is around 80 degrees Celsius, not boiling.",
      instruction_detailed: "Boiling water (100°C) will scorch the delicate tea leaves and release bitter tannins, ruining the sweet umami flavor.",
      source_timestamp_seconds: 46,
      tips: ["If you boiled your kettle, let it sit with the lid open for 2 minutes to drop down to 80°C."]
    },
    {
      id: "step_04",
      step_number: 4,
      title: "The Rapid W-Whisking Motion",
      instruction_spoken: "Hold the whisk upright with your fingers relaxed. Whisk vigorously back and forth in a rapid W motion from your wrist, keeping the whisk off the bottom.",
      instruction_detailed: "Do not stir in a circular motion. The rapid back-and-forth agitation incorporates micro air bubbles into the liquid.",
      source_timestamp_seconds: 64,
      tips: ["Keep your elbow stationary and isolate the movement entirely to your wrist for maximum speed."]
    },
    {
      id: "step_05",
      step_number: 5,
      title: "Break Large Bubbles & Finish Surface",
      instruction_spoken: "Once a rich jade foam covers the surface, slow your whisking down and gently trace across the top to pop any large remaining bubbles.",
      instruction_detailed: "A perfect ceremonial cup features a dense, velvet-like micro-foam resembling espresso crema.",
      source_timestamp_seconds: 82,
      tips: ["Slowly lift the whisk straight out from the center of the bowl to leave a neat mound of foam."]
    },
    {
      id: "step_06",
      step_number: 6,
      title: "Hold Chawan with Both Hands and Savor",
      instruction_spoken: "Lift the chawan with both hands, placing your right hand on the side and resting the base in your left palm. Enjoy your fresh ceremonial matcha.",
      instruction_detailed: "Traditional appreciation emphasizes gratitude, warmth in the hands, and enjoying the vibrant aroma before the first sip.",
      source_timestamp_seconds: 96,
      tips: ["Drink while warm within 3 minutes before the suspended matcha solids settle to the bottom."]
    }
  ]
}

export function App(): JSX.Element {
  const [activeTab, setActiveTab] = useState<"learning" | "teaching">("learning")

  // Teaching State
  const [teachingStatus, setTeachingStatus] = useState<"idle" | "recording" | "processing" | "review">("idle")
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [frameCount, setFrameCount] = useState(0)
  const [capturedPhotos, setCapturedPhotos] = useState<Array<{photoUrl: string; frameIndex: number}>>([])
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [titleInput, setTitleInput] = useState("")
  const [descInput, setDescInput] = useState("")
  const [generatedTutorial, setGeneratedTutorial] = useState<TutorialModel | null>(null)

  // Learning State
  const [tutorials, setTutorials] = useState<TutorialModel[]>([DEFAULT_MATCHA_TUTORIAL])
  const [activeTutorial, setActiveTutorial] = useState<TutorialModel | null>(null)
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [assistantState, setAssistantState] = useState<"idle" | "listening" | "thinking" | "speaking">("idle")
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    {
      id: "msg_init",
      speaker: "tinker",
      text: "Hello! I am Tinker, your smart glasses tutor. Put on your Mentra Live glasses, pick a tutorial, and let's get started.",
      isFinal: true,
      timestamp: "Ready"
    }
  ])
  const [textQuery, setTextQuery] = useState("")

  // Hardware Status State
  const [statusState, setStatusState] = useState<{
    glassesConnected: boolean
    hasCamera: boolean
    hasMic: boolean
    backendConnected: boolean
    message?: string
  }>({
    glassesConnected: true,
    hasCamera: true,
    hasMic: true,
    backendConnected: false,
    message: "Mentra Live Ready"
  })

  const transcriptEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({behavior: "smooth"})
  }, [transcript])

  // Subscribe to Mentra channel events
  useEffect(() => {
    if (typeof mentra === "undefined") return

    const unsubTeaching = mentra.on("teachingState", (data) => {
      setTeachingStatus(data.status)
      setElapsedSeconds(data.elapsedSeconds)
      setFrameCount(data.frameCount)
    })

    const unsubPhoto = mentra.on("photoCapture", (data) => {
      setCapturedPhotos((prev) => [...prev, {photoUrl: data.photoUrl, frameIndex: data.frameIndex}])
    })

    const unsubGen = mentra.on("tutorialGenerated", (data) => {
      if (data.status === "success" && data.tutorial) {
        setGeneratedTutorial(data.tutorial)
        setTitleInput(data.tutorial.title)
        setDescInput(data.tutorial.description)
        setTeachingStatus("review")
      }
    })

    const unsubList = mentra.on("tutorialList", (data) => {
      if (data.tutorials && data.tutorials.length > 0) {
        setTutorials(data.tutorials)
      }
    })

    const unsubLearning = mentra.on("learningState", (data) => {
      setCurrentStepIndex(data.currentStep - 1)
      setAssistantState(data.assistantState)
    })

    const unsubTxn = mentra.on("transcriptionUpdate", (data) => {
      setTranscript((prev) => {
        // Replace interim if last was interim from same speaker
        if (!data.isFinal && prev.length > 0 && prev[prev.length - 1].speaker === data.speaker && !prev[prev.length - 1].isFinal) {
          const next = [...prev]
          next[next.length - 1] = data
          return next
        }
        return [...prev, data]
      })
    })

    const unsubAssistant = mentra.on("assistantState", (data) => {
      setAssistantState(data.state)
    })

    const unsubConn = mentra.on("connectionStatus", (data) => {
      setStatusState(data)
    })

    const unsubStream = mentra.on("streamReady", (data) => {
      setStreamUrl(data.hlsUrl)
    })

    // Request initial state from background
    mentra.send("requestTutorials", {})
    mentra.send("ping", {at: Date.now()})

    return () => {
      unsubTeaching()
      unsubPhoto()
      unsubGen()
      unsubList()
      unsubLearning()
      unsubTxn()
      unsubAssistant()
      unsubConn()
      unsubStream()
    }
  }, [])

  // Timer effect for client-side display fallback during recording
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>
    if (teachingStatus === "recording") {
      interval = setInterval(() => {
        setElapsedSeconds((s) => s + 1)
      }, 1000)
    }
    return () => clearInterval(interval)
  }, [teachingStatus])

  // Actions
  const handleStartRecording = () => {
    setCapturedPhotos([])
    setElapsedSeconds(0)
    setFrameCount(0)
    setTeachingStatus("recording")
    if (typeof mentra !== "undefined") {
      mentra.send("startTeaching", {targetSkill: "Matcha Demonstration"})
    }
  }

  const handleStopRecording = () => {
    setTeachingStatus("processing")
    if (typeof mentra !== "undefined") {
      mentra.send("stopTeaching", {})
    } else {
      // Mock synthesis preview if testing in standalone browser
      setTimeout(() => {
        setGeneratedTutorial(DEFAULT_MATCHA_TUTORIAL)
        setTitleInput(DEFAULT_MATCHA_TUTORIAL.title)
        setDescInput(DEFAULT_MATCHA_TUTORIAL.description)
        setTeachingStatus("review")
      }, 2000)
    }
  }

  const handlePublishTutorial = () => {
    if (!generatedTutorial) return
    const updated: TutorialModel = {
      ...generatedTutorial,
      title: titleInput || generatedTutorial.title,
      description: descInput || generatedTutorial.description,
      status: "published"
    }
    setTutorials((prev) => [updated, ...prev])
    if (typeof mentra !== "undefined") {
      mentra.send("publishTutorial", {tutorial: updated})
    }
    setTeachingStatus("idle")
    setActiveTab("learning")
  }

  const handleStartLearning = (tut: TutorialModel) => {
    setActiveTutorial(tut)
    setCurrentStepIndex(0)
    setTranscript([
      {
        id: `start_${Date.now()}`,
        speaker: "system",
        text: `Started: ${tut.title}`,
        isFinal: true,
        timestamp: "Now"
      },
      {
        id: `step1_${Date.now()}`,
        speaker: "tinker",
        text: tut.steps[0]?.instruction_spoken || "Let's begin.",
        isFinal: true,
        timestamp: "Step 1",
        step: 1
      }
    ])
    if (typeof mentra !== "undefined") {
      mentra.send("startLearning", {tutorialId: tut.id})
    }
  }

  const handleEndLearning = () => {
    setActiveTutorial(null)
    if (typeof mentra !== "undefined") {
      mentra.send("endLearning", {})
    }
  }

  const handleStepNavigation = (direction: "next" | "previous" | "repeat") => {
    if (!activeTutorial) return

    let nextIndex = currentStepIndex
    if (direction === "next" && currentStepIndex < activeTutorial.steps.length - 1) {
      nextIndex = currentStepIndex + 1
    } else if (direction === "previous" && currentStepIndex > 0) {
      nextIndex = currentStepIndex - 1
    }

    setCurrentStepIndex(nextIndex)
    const step = activeTutorial.steps[nextIndex]

    setTranscript((prev) => [
      ...prev,
      {
        id: `nav_${Date.now()}`,
        speaker: "tinker",
        text: step?.instruction_spoken || "",
        isFinal: true,
        timestamp: `Step ${nextIndex + 1}`,
        step: nextIndex + 1
      }
    ])

    if (typeof mentra !== "undefined") {
      mentra.send("navigateStep", {direction})
    }
  }

  const handleSendQuery = (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!textQuery.trim()) return

    const q = textQuery.trim()
    setTextQuery("")

    setTranscript((prev) => [
      ...prev,
      {
        id: `user_${Date.now()}`,
        speaker: "user",
        text: q,
        isFinal: true,
        timestamp: "You"
      }
    ])

    setAssistantState("thinking")

    if (typeof mentra !== "undefined") {
      mentra.send("askTinker", {text: q})
    } else {
      // Standalone browser testing fallback
      setTimeout(() => {
        setAssistantState("speaking")
        setTranscript((prev) => [
          ...prev,
          {
            id: `reply_${Date.now()}`,
            speaker: "tinker",
            text: `Regarding "${q}": Keep your wrist loose and whisk rapidly in a W shape. You want fine micro-foam, not large surface bubbles!`,
            isFinal: true,
            timestamp: "Tinker"
          }
        ])
        setTimeout(() => setAssistantState("idle"), 2500)
      }, 1000)
    }
  }

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  const currentStep: TutorialStepModel | undefined = activeTutorial?.steps[currentStepIndex]

  return (
    <div className="tinker-container">
      {/* Header */}
      <header className="tinker-header">
        <div className="brand-wrapper">
          <h1 className="brand-title">TINKER</h1>
          <p className="brand-tagline">Learn by doing. Teach by showing.</p>
        </div>
        <div className="status-pills">
          <div className={`status-pill ${statusState.glassesConnected ? "connected" : ""}`}>
            <span className="status-dot"></span>
            <span>Mentra Live {statusState.glassesConnected ? "Connected" : "Disconnected"}</span>
          </div>
          <div className={`status-pill ${statusState.backendConnected ? "connected" : ""}`}>
            <span className="status-dot"></span>
            <span>Backend {statusState.backendConnected ? "Active" : "Offline"}</span>
          </div>
        </div>
      </header>

      {/* Primary 2-Tab Navigation */}
      <nav className="tab-navigation">
        <button
          type="button"
          className={`tab-btn ${activeTab === "learning" ? "active" : ""}`}
          onClick={() => setActiveTab("learning")}
        >
          <GraduationCapIcon size={18} />
          <span>Learning</span>
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "teaching" ? "active" : ""}`}
          onClick={() => setActiveTab("teaching")}
        >
          <VideoIcon size={18} />
          <span>Teaching</span>
        </button>
      </nav>

      {/* Main Content Area */}
      <main>
        {/* ============================================================== */}
        {/* TAB 1: TEACHING MODE */}
        {/* ============================================================== */}
        {activeTab === "teaching" && (
          <div>
            {teachingStatus === "idle" && (
              <div className="card teaching-hero">
                <h2>Teach a Skill</h2>
                <p>
                  Put on your Mentra Live smart glasses and demonstrate any hands-on skill.
                  Tinker captures your first-person point of view and uses multimodal AI to synthesize a step-by-step tutorial.
                </p>

                <div className="hardware-checklist">
                  <div className={`checklist-item ${statusState.hasCamera ? "ready" : ""}`}>
                    <CheckCircleIcon size={16} />
                    <span>Wide-Angle Camera Ready</span>
                  </div>
                  <div className={`checklist-item ${statusState.hasMic ? "ready" : ""}`}>
                    <CheckCircleIcon size={16} />
                    <span>Directional Mic Ready</span>
                  </div>
                  <div className="checklist-item ready">
                    <CheckCircleIcon size={16} />
                    <span>Displayless Audio Mode</span>
                  </div>
                </div>

                <button type="button" className="btn btn-primary" onClick={handleStartRecording} style={{padding: "14px 32px", fontSize: "1.1rem"}}>
                  <VideoIcon size={20} />
                  <span>Start Recording Demonstration</span>
                </button>
              </div>
            )}

            {teachingStatus === "recording" && (
              <div className="card recording-panel">
                <div className="record-indicator">
                  <span className="pulse-dot"></span>
                  <span>Live Recording via Mentra Live</span>
                </div>

                <div className="timer-display">{formatTimer(elapsedSeconds)}</div>
                <div className="frame-count-badge">Captured Frames: <strong>{frameCount || Math.floor(elapsedSeconds / 4)}</strong></div>

                <div className="viewfinder-preview">
                  {streamUrl ? (
                    <video src={streamUrl} autoPlay muted playsInline />
                  ) : capturedPhotos.length > 0 ? (
                    <img src={capturedPhotos[capturedPhotos.length - 1].photoUrl} alt="Live frame" />
                  ) : (
                    <div className="viewfinder-placeholder">
                      <VideoIcon size={40} />
                      <span>POV Camera Stream Active</span>
                      <span style={{fontSize: "0.75rem", opacity: 0.7}}>Frames sampling every 4s for AI analysis</span>
                    </div>
                  )}
                </div>

                <button type="button" className="btn btn-danger" onClick={handleStopRecording} style={{padding: "14px 28px"}}>
                  <SquareIcon size={18} />
                  <span>Stop Recording & Synthesize</span>
                </button>
              </div>
            )}

            {teachingStatus === "processing" && (
              <div className="card" style={{textAlign: "center", padding: "48px 20px"}}>
                <SparklesIcon size={48} className="speaking" style={{margin: "0 auto 16px", color: "var(--primary-green)"}} />
                <h3 style={{fontSize: "1.4rem", marginBottom: "8px"}}>AI Analyzing Demonstration...</h3>
                <p style={{color: "var(--text-muted)", maxWidth: "480px", margin: "0 auto 20px"}}>
                  Claude 3.5 Sonnet is inspecting the chronological keyframes, identifying hand actions, tools, and synthesizing procedural steps.
                </p>
                <div className="progress-bar-container" style={{maxWidth: "360px", margin: "0 auto"}}>
                  <div className="progress-bar-fill" style={{width: "70%"}}></div>
                </div>
              </div>
            )}

            {teachingStatus === "review" && generatedTutorial && (
              <div className="card review-form">
                <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-light)", paddingBottom: "12px"}}>
                  <h3 style={{fontSize: "1.3rem", fontWeight: 700}}>Review & Publish Tutorial</h3>
                  <span className="tutorial-tag">{generatedTutorial.steps.length} Steps Detected</span>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="tut-title">Tutorial Title</label>
                  <input
                    id="tut-title"
                    type="text"
                    className="form-input"
                    value={titleInput}
                    onChange={(e) => setTitleInput(e.target.value)}
                    placeholder="e.g. Ceremonial Matcha Preparation"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="tut-desc">Description</label>
                  <textarea
                    id="tut-desc"
                    className="form-textarea"
                    rows={3}
                    value={descInput}
                    onChange={(e) => setDescInput(e.target.value)}
                    placeholder="Brief description of the technique and outcome"
                  />
                </div>

                <div>
                  <h4 style={{fontSize: "1rem", fontWeight: 700, margin: "16px 0 10px"}}>Generated Steps</h4>
                  <div style={{display: "flex", flexDirection: "column", gap: "10px"}}>
                    {generatedTutorial.steps.map((st, i) => (
                      <div key={st.id || i} style={{padding: "12px 16px", background: "var(--bg-sage)", borderRadius: "var(--radius-sm)", borderLeft: "3px solid var(--primary-green)"}}>
                        <div style={{display: "flex", justifyContent: "space-between", fontSize: "0.85rem", fontWeight: 700, marginBottom: "4px"}}>
                          <span>Step {st.step_number}: {st.title}</span>
                          <span style={{color: "var(--text-muted)"}}>t={st.source_timestamp_seconds || i * 15}s</span>
                        </div>
                        <p style={{fontSize: "0.9rem", color: "var(--text-main)"}}>{st.instruction_spoken}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{display: "flex", gap: "12px", justifyContent: "flex-end", marginTop: "16px"}}>
                  <button type="button" className="btn btn-secondary" onClick={() => setTeachingStatus("idle")}>
                    Discard
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handlePublishTutorial}>
                    <CheckCircleIcon size={18} />
                    <span>Publish to Library</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============================================================== */}
        {/* TAB 2: LEARNING MODE */}
        {/* ============================================================== */}
        {activeTab === "learning" && (
          <div>
            {!activeTutorial ? (
              <div>
                <div className="catalog-header">
                  <h2 className="catalog-title">Skill Tutorials</h2>
                  <span style={{fontSize: "0.85rem", color: "var(--text-muted)"}}>
                    {tutorials.length} Available
                  </span>
                </div>

                <div className="tutorial-grid">
                  {tutorials.map((tut) => (
                    <div key={tut.id} className="tutorial-card">
                      <div>
                        <span className="tutorial-tag">{tut.category || "Skill"}</span>
                        <h3 className="tutorial-title">{tut.title}</h3>
                        <p className="tutorial-desc">{tut.description}</p>
                      </div>
                      <div>
                        <div className="tutorial-meta">
                          <span><strong>{tut.steps.length}</strong> Steps</span>
                          <span>Est. <strong>{tut.estimated_duration_minutes || 5}</strong> min</span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{width: "100%"}}
                          onClick={() => handleStartLearning(tut)}
                        >
                          <PlayIcon size={16} />
                          <span>Start Learning</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="session-layout">
                {/* Active Session Header */}
                <div className="session-header">
                  <div>
                    <h2 style={{fontSize: "1.25rem", fontWeight: 700}}>{activeTutorial.title}</h2>
                    <span style={{fontSize: "0.85rem", color: "var(--text-muted)"}}>
                      Audio delivered directly via Mentra Live speakers
                    </span>
                  </div>
                  <button type="button" className="btn btn-secondary" onClick={handleEndLearning}>
                    End Session
                  </button>
                </div>

                {/* Progress Bar */}
                <div>
                  <div style={{display: "flex", justifyContent: "space-between", fontSize: "0.85rem", fontWeight: 600}}>
                    <span>Step {currentStepIndex + 1} of {activeTutorial.steps.length}</span>
                    <span>{Math.round(((currentStepIndex + 1) / activeTutorial.steps.length) * 100)}% Complete</span>
                  </div>
                  <div className="progress-bar-container">
                    <div
                      className="progress-bar-fill"
                      style={{width: `${((currentStepIndex + 1) / activeTutorial.steps.length) * 100}%`}}
                    ></div>
                  </div>
                </div>

                {/* Current Instruction Card */}
                {currentStep && (
                  <div className="step-card">
                    <span className="step-badge">Step {currentStep.step_number}: {currentStep.title}</span>
                    <h3 className="step-instruction">{currentStep.instruction_spoken}</h3>
                    <p className="step-detailed">{currentStep.instruction_detailed}</p>

                    {currentStep.tips && currentStep.tips.length > 0 && (
                      <div className="step-tips">
                        <strong>Tip:</strong> {currentStep.tips[0]}
                      </div>
                    )}
                  </div>
                )}

                {/* Tinker Assistant Status Bar */}
                <div className="tinker-status-card">
                  <div style={{display: "flex", alignItems: "center", gap: "10px"}}>
                    <Volume2Icon size={20} style={{color: "var(--primary-green)"}} />
                    <div>
                      <div style={{fontSize: "0.875rem", fontWeight: 700}}>Tinker Voice Instructor</div>
                      <div style={{fontSize: "0.75rem", color: "var(--text-muted)"}}>Speak naturally into your glasses</div>
                    </div>
                  </div>

                  <div style={{display: "flex", alignItems: "center", gap: "12px"}}>
                    <div className={`tinker-pill ${assistantState}`}>
                      <span className="status-dot" style={{backgroundColor: assistantState === "speaking" ? "var(--primary-green)" : assistantState === "listening" ? "#0284C7" : assistantState === "thinking" ? "#D97706" : "#668B5B"}}></span>
                      <span style={{textTransform: "capitalize"}}>{assistantState}</span>
                    </div>

                    <div className={`waveform ${assistantState === "speaking" ? "speaking" : ""}`}>
                      <div className="wave-bar"></div>
                      <div className="wave-bar"></div>
                      <div className="wave-bar"></div>
                      <div className="wave-bar"></div>
                    </div>
                  </div>
                </div>

                {/* Live Transcript Card */}
                <div className="transcript-card">
                  <div className="transcript-header">Live Conversation Transcript</div>
                  <div className="transcript-list">
                    {transcript.map((msg) => (
                      <div key={msg.id} className={`transcript-item ${msg.speaker}`}>
                        <div>{msg.text}</div>
                        <div className="transcript-meta">{msg.timestamp} {msg.step ? `• Step ${msg.step}` : ""}</div>
                      </div>
                    ))}
                    <div ref={transcriptEndRef}></div>
                  </div>

                  {/* Fallback query input */}
                  <form onSubmit={handleSendQuery} style={{display: "flex", gap: "8px", marginTop: "12px"}}>
                    <input
                      type="text"
                      className="form-input"
                      style={{flex: 1, padding: "8px 12px", fontSize: "0.85rem"}}
                      placeholder="Ask Tinker a question (or speak into glasses)..."
                      value={textQuery}
                      onChange={(e) => setTextQuery(e.target.value)}
                    />
                    <button type="submit" className="btn btn-secondary" style={{padding: "8px 14px"}}>
                      <SendIcon size={16} />
                    </button>
                  </form>
                </div>

                {/* Session Navigation Controls */}
                <div className="session-controls">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleStepNavigation("previous")}
                    disabled={currentStepIndex === 0}
                  >
                    <ArrowLeftIcon size={18} />
                    <span>Previous Step</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleStepNavigation("repeat")}
                  >
                    <RotateCcwIcon size={18} />
                    <span>Repeat Instruction</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => handleStepNavigation("next")}
                    disabled={currentStepIndex >= activeTutorial.steps.length - 1}
                  >
                    <span>Next Step</span>
                    <ArrowRightIcon size={18} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
