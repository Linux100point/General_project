import assert from 'node:assert/strict';
import test from 'node:test';
import { MockAIProvider, MockMatchingService } from './MockMatchingService';

test('mock matching continues to return recommendations and globally unique final assignments', async () => {
  const mentors = [
    { id: 'mentor-a', name: 'Mentor A', cvFileIds: [] },
    { id: 'mentor-b', name: 'Mentor B', cvFileIds: [] },
  ];
  const students = Array.from({ length: 5 }, (_, index) => ({
    id: `S${index + 1}`,
    studentId: `S${index + 1}`,
    name: `Student ${index + 1}`,
    desiredSkills: 'TypeScript',
    topicsForExpertConsultation: 'API design',
    projectOverview: 'Education platform',
    mentorshipSupportNeeds: 'Architecture feedback',
  }));
  const service = new MockMatchingService(new MockAIProvider());

  const result = await service.run({ mentors, students });

  assert.equal(result.status, 'draft');
  assert.equal(result.currentRecommendations.length, 10);
  assert.equal(result.finalAssignments.length, 3);
  assert.equal(new Set(result.finalAssignments.map((assignment) => assignment.studentId)).size, result.finalAssignments.length);
});
