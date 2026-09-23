import { useParams } from "react-router";

export default function User() {
  const { id } = useParams();
  return <p>User {id}</p>;
}
