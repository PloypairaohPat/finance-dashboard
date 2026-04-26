import { Request, Response } from "express"
import { getUserId } from "../middleware/auth"
import {
  fetchGoalsWithProgress, createGoal, updateGoal, deleteGoal,
} from "../services/goals.service"

export async function getGoals(req: Request, res: Response) {
  try {
    res.json(await fetchGoalsWithProgress(getUserId(req)))
  } catch (err: any) {
    console.error("getGoals error:", err.message)
    res.status(500).json({ error: "Failed to fetch goals" })
  }
}

export async function postGoal(req: Request, res: Response) {
  try {
    const goal = await createGoal(getUserId(req), req.body)
    res.json(goal)
  } catch (err: any) {
    console.error("postGoal error:", err.message)
    const status = /required|invalid|link/i.test(err.message) ? 400 : 500
    res.status(status).json({ error: err.message })
  }
}

export async function patchGoal(req: Request, res: Response) {
  try {
    const goal = await updateGoal(getUserId(req), req.params.id as string, req.body)
    res.json(goal)
  } catch (err: any) {
    res.status(err.message === "Goal not found" ? 404 : 500)
       .json({ error: err.message })
  }
}

export async function removeGoal(req: Request, res: Response) {
  try {
    await deleteGoal(getUserId(req), req.params.id as string)
    res.json({ success: true })
  } catch (err: any) {
    res.status(err.message === "Goal not found" ? 404 : 500)
       .json({ error: err.message })
  }
}