-- CreateTable
CREATE TABLE "Mindmap" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mindmap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Mindmap_institutionId_teacherId_idx" ON "Mindmap"("institutionId", "teacherId");

-- AddForeignKey
ALTER TABLE "Mindmap" ADD CONSTRAINT "Mindmap_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mindmap" ADD CONSTRAINT "Mindmap_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
